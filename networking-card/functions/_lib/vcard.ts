const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Klan;David;;;',
  'FN:David Klan',
  'ORG:Dazbeez',
  'TITLE:AI, Automation & Data Consultant',
  'EMAIL;TYPE=INTERNET:david@dazbeez.com',
  'URL:https://dazbeez.com',
  'END:VCARD',
].join('\r\n');

export function generateVCard(): string {
  return VCARD;
}
