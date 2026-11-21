// Writes the template as XO template JSON (templates/lotry.json), the form the XO debug tool and engine import,
// and prints its template identifier (a hash of its content).
import fs from 'node:fs';
import { generateTemplateIdentifier, parseTemplate, serializeTemplate } from '@xo-cash/utils';
import { lotryTemplate } from '../src/lotry-template.mjs';

fs.mkdirSync('templates', { recursive: true });
const json = serializeTemplate(lotryTemplate);
fs.writeFileSync('templates/lotry.json', `${json}\n`);
// The engine hashes the template as it parses it from JSON; that is the identifier every invitation carries.
console.log(`templates/lotry.json  identifier ${generateTemplateIdentifier(parseTemplate(json))}`);
