#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const checkedFiles = [
  "src/index.tsx",
  "src/routes/customer.tsx",
  "src/routes/staffApi.ts",
  "src/lib/brevo.ts",
  "src/services/extension.ts",
];

const forbidden = [
  {
    pattern: /centersurvey|survey-banner/i,
    reason: "Survey banner must not be rendered on customer-facing surfaces.",
  },
  {
    pattern: /data:image\/svg\+xml/i,
    reason: "Do not replace branded R2 promo images with inline placeholder SVGs.",
  },
  {
    pattern: /wk7y2gnip6|wk7dc2q88b/i,
    reason: "Do not reuse Microsoft Clarity project IDs from other Flying Japan products.",
  },
  {
    pattern: /captureMessage\("customer_resource_load_failed"\)/,
    reason: "Customer resource alerts must use the actionable required-resource failure message.",
  },
  {
    pattern: /Collected Information:\s*Name,\s*contact number/i,
    reason: "Privacy notice must list every customer form field that is collected.",
  },
  {
    pattern: /수집 항목:\s*이름,\s*연락처/i,
    reason: "Privacy notice must list every customer form field that is collected.",
  },
  {
    pattern: /収集項目：\s*氏名、連絡先/i,
    reason: "Privacy notice must list every customer form field that is collected.",
  },
  {
    pattern: /¥\s+\{price_per_day\}/,
    reason: "Price preview metadata must not prepend a second yen symbol before the formatted price.",
  },
];

const customerNoticeRequirements = [
  "Collected Information: name, phone number, email address, ID/passport photo, luggage photo",
  "수집 항목: 이름, 전화번호, 이메일, 신분증/여권 사진, 짐 사진",
  "収集項目： 氏名、電話番号、メールアドレス、本人確認書類（パスポート等）の写真、荷物写真",
];

const customerObservabilityRequirements = [
  "isOptionalExternalResourceFailure",
  "customer_required_resource_load_failed",
  "browser.sentry-cdn.com",
  "static.cloudflareinsights.com",
];

const operationalGuardRequirements = {
  "src/index.tsx": [
    'env.AUTO_EXTENSION_ENABLED === "true"',
    "Extension orders skipped: AUTO_EXTENSION_ENABLED is not true",
  ],
  "src/routes/staffApi.ts": [
    "parent_order_id IS NULL",
    "datetime(created_at) > datetime(?)",
  ],
  "src/services/extension.ts": [
    "toSqliteDateTime",
    "created_at: toSqliteDateTime(now)",
  ],
};

const failures = [];

for (const relativePath of checkedFiles) {
  const source = readFileSync(join(root, relativePath), "utf8");
  for (const check of forbidden) {
    if (check.pattern.test(source)) {
      failures.push(`${relativePath}: ${check.reason}`);
    }
  }

  if (relativePath === "src/routes/customer.tsx") {
    for (const snippet of customerNoticeRequirements) {
      if (!source.includes(snippet)) {
        failures.push(`${relativePath}: Customer privacy notice is missing required text: ${snippet}`);
      }
    }

    for (const snippet of customerObservabilityRequirements) {
      if (!source.includes(snippet)) {
        failures.push(`${relativePath}: Customer observability guard is missing required text: ${snippet}`);
      }
    }
  }

  for (const snippet of operationalGuardRequirements[relativePath] || []) {
    if (!source.includes(snippet)) {
      failures.push(`${relativePath}: Operational guard is missing required text: ${snippet}`);
    }
  }
}

if (failures.length) {
  console.error("Customer asset guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Customer asset guard passed.");
