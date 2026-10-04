import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import addFormatsModule from 'ajv-formats';

// Validates server.json against the official MCP Registry schema it declares.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void;
const server: { $schema: string } = JSON.parse(readFileSync('server.json', 'utf8'));
const res = await fetch(server.$schema);
if (!res.ok) throw new Error(`Could not download ${server.$schema}: ${res.status}`);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(await res.json());
if (!validate(server)) {
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exit(1);
}
console.log(`server.json is valid against ${server.$schema}`);
