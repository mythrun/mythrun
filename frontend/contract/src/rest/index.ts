// Barrel for the REST response-schema contract. Re-exports the user-scoped
// (/me) and campaign-scoped (/mine) home-hub-smoke response schemas + their
// inferred types. The backend consumes the inferred TYPES via
// `@mythrun/contract/rest` to type its handler returns against the wire shape;
// clients consume the SCHEMAS to validate inbound responses.
export * from './users.js'
export * from './campaigns.js'
