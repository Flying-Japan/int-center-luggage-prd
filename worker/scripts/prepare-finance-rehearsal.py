#!/usr/bin/env python3
"""Local copies only. Never opens a source writable or accepts an existing target."""
import argparse, datetime, hashlib, json, os, re, sqlite3, tempfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--run-local', action='store_true', required=True)
parser.add_argument('--source', type=Path, required=True)
args = parser.parse_args()
source = args.source.resolve(strict=True)
assert source.is_file() and source.suffix in ('.sqlite', '.db')
assert not Path(str(source)+'-wal').exists(), 'Use a verified checkpointed source; never modify it here'
root = Path(tempfile.mkdtemp(prefix='flying-finance-rehearsal-'))
os.chmod(root, 0o700)
worker = Path(__file__).resolve().parent.parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
source_sha = sha(source)
old = sqlite3.connect(source.as_uri()+'?mode=ro&immutable=1', uri=True)
assert 'extension_date' not in [r[1] for r in old.execute('PRAGMA table_info(luggage_orders)')], 'An unmigrated production copy is required'

def quote(s): return '"'+s.replace('"','""')+'"'
def fingerprint(db, columns=None):
    result = {}
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    for table in (columns or tables):
        cols = columns[table]['columns'] if columns else [r[1] for r in db.execute('PRAGMA table_info('+quote(table)+')')]
        keys = ','.join(map(quote, cols)); digest = hashlib.sha256(); count = 0
        for row in db.execute('SELECT '+keys+' FROM '+quote(table)+' ORDER BY '+keys):
            digest.update(json.dumps(row, ensure_ascii=False, separators=(',',':'), default=lambda b: {'blob':bytes(b).hex()}).encode());digest.update(b'\n');count += 1
        result[table] = {'columns':cols, 'rows':count, 'sha256':digest.hexdigest()}
    return result

def statements(sql):
    result=[];buf=''
    for c in sql:
        buf+=c
        if c==';' and sqlite3.complete_statement(buf):result.append(buf.strip());buf=''
    assert not re.sub(r'--[^\n]*|/\*[\s\S]*?\*/', '', buf).strip(), 'Incomplete SQL tail'
    return result

def canonical(sql):
    tokens=re.findall(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_][A-Za-z_0-9]*|\d+|!=|<>|>=|<=|\|\||\S",sql)
    tokens=[t if t[0] in "'\"`[" else t.upper() for t in tokens if not t.startswith(('--','/*'))]
    i=3 if tokens[1:2]==['UNIQUE'] else 2
    if tokens[i:i+3]==['IF','NOT','EXISTS']: del tokens[i:i+3]
    if tokens[-1:]==[';']:tokens.pop()
    return tokens

before = fingerprint(old)
for name in ['before.sqlite','migrated.sqlite']:
    db=sqlite3.connect(root/name);old.backup(db);db.close();os.chmod(root/name,0o600)
old.close()
db=sqlite3.connect(root/'migrated.sqlite')
report={'root':str(root),'source':str(source),'source_sha256':source_sha,'snapshot_freshness':'Held local export only; not a new live backup','source_tables':before,'migrations':[],'passed':False}
try:
    assert before['luggage_orders']['rows']==26978 and before['luggage_order_payments']['rows']==12099 and before['luggage_audit_logs']['rows']==54644
    migration_batches=[]
    for name in ['20261025_extension_receipts.sql','20261026_root_settlement_review.sql']:
        p=worker/'migrations'/name;sql=p.read_text();batch=statements(sql);migration_batches.append({'name':name,'sha256':sha(p),'statements':batch})
        try: db.executescript('BEGIN IMMEDIATE;\n'+sql+'\nCOMMIT;')
        except Exception: db.rollback();raise
        assert fingerprint(db,before)==before, 'Original rows or financial history changed'
        report['migrations'].append({'name':name,'sha256':sha(p),'statements':len(batch),'original_rows_preserved':True})
    fresh=sqlite3.connect(':memory:');fresh.executescript((worker/'src/schema.sql').read_text())
    names=set(re.findall(r'CREATE\s+(?:UNIQUE\s+)?(?:VIEW|TRIGGER|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)', '\n'.join((worker/'migrations'/x['name']).read_text() for x in migration_batches), re.I))
    for name in names:
        actual=db.execute('SELECT sql FROM sqlite_master WHERE name=?',(name,)).fetchone()
        expected=fresh.execute('SELECT sql FROM sqlite_master WHERE name=?',(name,)).fetchone()
        assert actual and expected and canonical(actual[0])==canonical(expected[0]), 'Schema definition mismatch: '+name
    report['financial_objects_match_fresh_schema']=len(names)
    report['balances']=dict(zip(['roots','reviews','review_amount','outstanding','extension_outstanding'],db.execute('SELECT COUNT(*),SUM(root_review_required),SUM(root_review_amount),SUM(outstanding_amount),SUM(extension_outstanding_amount) FROM luggage_billing_balances').fetchone()))
    assert report['balances']['reviews']==366 and report['balances']['review_amount']==348839
    assert not db.execute("SELECT 1 FROM sqlite_master WHERE name LIKE '%part_time%'").fetchone()
    # Local restore rehearsal: restore to a separate fresh file; no production recovery command exists here.
    restored=sqlite3.connect(root/'restored-before.sqlite');read_before=sqlite3.connect((root/'before.sqlite').as_uri()+'?mode=ro&immutable=1',uri=True);read_before.backup(restored);read_before.close()
    assert fingerprint(restored,before)==before
    assert not restored.execute("SELECT 1 FROM sqlite_master WHERE name='luggage_billing_balances'").fetchone();restored.close()
    report['restore_to_separate_copy_passed']=True
    (root/'migration-batches.json').write_text(json.dumps(migration_batches))
    report['passed']=True
finally:
    db.close();assert sha(source)==source_sha,'Source copy changed'
    report['source_preserved']=True
    (root/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['root','source_sha256','migrations','passed','source_preserved']}))
