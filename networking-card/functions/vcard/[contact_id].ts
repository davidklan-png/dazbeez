import { generateVCard } from '../_lib/vcard';

export const onRequestGet: PagesFunction = async (context) => {
  const vcf = generateVCard();

  return new Response(vcf, {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': 'attachment; filename="david-klan.vcf"',
    },
  });
};
