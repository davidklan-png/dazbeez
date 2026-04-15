import { getVCardProfile } from '../_lib/db';
import { generateVCard } from '../_lib/vcard';

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async (context) => {
  const profile = await getVCardProfile(context.env.DB);
  const vcf = generateVCard(profile);

  return new Response(vcf, {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `attachment; filename="${profile.fileName}"`,
    },
  });
};
