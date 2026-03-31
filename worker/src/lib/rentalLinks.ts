export const RENTAL_PROMO_LINKS = {
  stroller: {
    main: "https://t2m.io/rentalbaby",
    finish: "https://t2m.io/rentalbaby_fisnishi",
    email: "https://t2m.io/rentalbaby_email",
  },
  dyson: {
    main: "https://t2m.io/rentaldyson",
    finish: "https://t2m.io/rentaldyson_email",
    email: "https://t2m.io/rentaldyson_email",
  },
  usj: {
    main: "https://t2m.io/rentalusj",
    finish: "https://t2m.io/rentalusj_finishi",
    email: "https://t2m.io/rentalusj_email",
  },
} as const;

export type RentalPromoContext = "main" | "finish" | "email";
