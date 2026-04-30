// backend/src/auth/constants.ts
//
// Shared sentinel between jwt-plugin and bypass-plugin. Used by both plugins
// to reject double-registration on the same Fastify instance.
export const REGISTERED_DECORATOR = 'mythAuthRegistered'
