/** 只接受同源 JSON POST：readBody 会忽略 Content-Type，这道闸缺了就会放行 text/plain。 */
export const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i
