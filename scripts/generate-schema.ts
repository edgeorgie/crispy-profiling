import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ConfigSchema } from '../src/config.js';

// JSON Schema for crispy.config.json (editor autocompletion + agents writing configs).
const schema = z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-7' });
const out = {
  ...schema,
  $id: 'https://raw.githubusercontent.com/edgeorgie/crispy-profiling/main/schema/crispy.config.schema.json',
  title: 'crispy-profiling config',
};
writeFileSync('schema/crispy.config.schema.json', `${JSON.stringify(out, null, 2)}\n`);
console.log('schema/crispy.config.schema.json written');
