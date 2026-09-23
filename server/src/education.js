// Patient education: short, plain-language pages about treatment, matched to the codes on a patient's plan
// and sent as a link. These come built in; an office can add its own or override one by using its slug.
// Paragraphs are separated by blank lines; lines starting "- " are bullet points.
export const BUILT_IN = [
  {
    slug: 'crowns', title: 'Your crown', codes: ['D27', 'D2950', 'D2954'],
    body: `A crown is a cap that covers a tooth to protect it and restore its shape and strength. We recommend one when a tooth is cracked, has a large filling that is failing, or has had a root canal.

It usually takes two visits. At the first we shape the tooth, take a scan or impression, and place a temporary crown. At the second we fit and cement your permanent crown. Some crowns can be made the same day.

While you have a temporary crown:
- Chew on the other side and avoid sticky or hard foods (caramel, gum, ice).
- Slide floss out sideways rather than pulling it up.
- If the temporary comes off, call us — keep it and don't leave the tooth uncovered for long.

A crown can last 10–15 years or more. Brush and floss around it like a natural tooth; the edge where it meets your tooth can still get decay.`,
  },
  {
    slug: 'root-canal', title: 'Root canal treatment', codes: ['D33', 'D32'],
    body: `A root canal saves a tooth whose nerve is infected or inflamed. We gently clean out the inside of the tooth, disinfect it, and seal it. It is done under local anesthetic and feels much like a filling.

Afterwards, the tooth may be sore to bite on for a few days. Over-the-counter pain relievers usually help; take any medicine we prescribed as directed.

Most back teeth need a crown after a root canal: the tooth becomes more brittle and can crack. Until the crown is placed, avoid chewing hard foods on that side.

Call us if you have swelling, pain that gets worse after three days, or your bite feels high.`,
  },
  {
    slug: 'gum-disease', title: 'Gum disease and deep cleanings', codes: ['D434', 'D4910', 'D4355'],
    body: `Gum (periodontal) disease is an infection of the gums and bone that hold your teeth. Early on it causes bleeding and puffy gums; left untreated it leads to bone loss, loose teeth and tooth loss. It is also linked to diabetes and heart disease.

A deep cleaning (scaling and root planing) removes hardened tartar and bacteria from below the gumline where a regular cleaning can't reach, so the gums can heal and tighten. It is usually done in two visits with numbing.

After a deep cleaning your gums may be tender and teeth sensitive to cold for a week or so. Rinse with warm salt water and keep brushing gently.

Gum disease is controlled, not cured. Periodontal maintenance visits every 3–4 months keep it from coming back.`,
  },
  {
    slug: 'implants', title: 'Dental implants', codes: ['D60', 'D61'],
    body: `An implant replaces a missing tooth's root with a small titanium post placed in the jawbone. After it bonds with the bone (usually 3–6 months), a crown is attached. It looks, feels and works like a natural tooth and doesn't rely on the teeth next to it.

After surgery, expect some swelling and soreness for a few days. Eat soft foods, avoid chewing on the area, don't smoke, and keep it clean as instructed.

Implants can last a lifetime with good brushing, flossing and regular checkups.`,
  },
  {
    slug: 'extraction-aftercare', title: 'After a tooth extraction', codes: ['D71', 'D72'],
    body: `Bite on the gauze for 30–60 minutes to let a clot form. Some oozing is normal for the first day.

For the first 24 hours:
- Don't rinse, spit forcefully, drink through a straw or smoke — these can dislodge the clot and cause a painful dry socket.
- Use an ice pack on your cheek, 20 minutes on and 20 off, to reduce swelling.
- Eat soft, cool foods.

After 24 hours, rinse gently with warm salt water after meals. Take pain medicine as directed.

Call us if bleeding doesn't slow with pressure, pain gets worse after two or three days, or you have a fever.`,
  },
  {
    slug: 'fillings', title: 'After your filling', codes: ['D21', 'D23', 'D24'],
    body: `Your lip, tongue and cheek may be numb for a few hours. Avoid hot drinks and chewing until the numbness wears off so you don't bite yourself.

White (composite) fillings are fully set when you leave. It's normal for the tooth to be a little sensitive to cold or biting for a week or two.

If your bite feels high or uneven after the numbness is gone, call us — a quick adjustment fixes it.`,
  },
  {
    slug: 'sealants', title: 'Sealants for children', codes: ['D1351', 'D1352'],
    body: `Sealants are thin protective coatings painted onto the chewing surfaces of back teeth, where most cavities in children start. They fill the deep grooves so food and bacteria can't settle there.

They are quick and painless — no numbing or drilling — and can protect teeth for years. We check them at each visit and touch them up if needed.`,
  },
  {
    slug: 'fluoride', title: 'Fluoride varnish', codes: ['D1206', 'D1208'],
    body: `Fluoride strengthens enamel and helps reverse the earliest stage of decay. The varnish is painted on in seconds and sets on contact with saliva.

For best results, wait 4–6 hours before brushing and avoid hot drinks and hard or sticky foods for the rest of the day.`,
  },
  {
    slug: 'bridges', title: 'Your bridge', codes: ['D62', 'D67'],
    body: `A bridge replaces a missing tooth with a false tooth held by crowns on the teeth on either side. It restores your bite and keeps the other teeth from shifting.

Food can collect under the false tooth, so cleaning under it every day matters. Use a floss threader, super floss or a water flosser — we'll show you how.`,
  },
  {
    slug: 'dentures', title: 'Caring for dentures', codes: ['D51', 'D52', 'D53', 'D54', 'D55', 'D56', 'D57', 'D58'],
    body: `New dentures take a few weeks to get used to. Start with soft foods cut into small pieces, chew on both sides, and read aloud to get used to speaking.

- Take dentures out at night to rest your gums.
- Brush them daily with a soft brush and denture cleaner (not toothpaste, which scratches) and keep them in water or solution when out.
- Brush your gums and tongue.

Sore spots are common at first — call us for an adjustment rather than putting up with them.`,
  },
  {
    slug: 'night-guard', title: 'Night guards', codes: ['D9944', 'D9945', 'D9946'],
    body: `Grinding or clenching at night can wear, chip and crack teeth and cause jaw pain and headaches. A night guard cushions your teeth and protects them.

Wear it every night. Rinse and brush it (without toothpaste) each morning and keep it in its case. Bring it to your checkups so we can check the fit.`,
  },
  {
    slug: 'whitening', title: 'Teeth whitening', codes: ['D9972', 'D9975'],
    body: `Whitening lightens the natural color of your teeth. Crowns, veneers and fillings don't change color, so we plan any replacements after whitening.

Sensitivity during whitening is common and temporary; a sensitivity toothpaste helps. For two days after each treatment, avoid coffee, tea, red wine and tobacco to keep the results.`,
  },
  {
    slug: 'orthodontics', title: 'Braces and aligners', codes: ['D80', 'D81', 'D86'],
    body: `Straightening teeth makes them easier to clean and improves your bite. With braces, avoid hard, sticky and chewy foods and brush carefully around each bracket. With aligners, wear them 20–22 hours a day and take them out to eat and drink anything but water.

Keep up your cleanings during treatment — food trapped around braces and under aligners raises the risk of decay. Wear your retainer as directed afterwards so teeth don't move back.`,
  },
];

// The office's own articles win over a built-in one with the same slug.
export async function libraryFor(db, pid) {
  const own = await db.all('SELECT slug, title, body, codes, active FROM education_articles WHERE practice_id = ? ORDER BY title', pid);
  const bySlug = new Map(BUILT_IN.map((a) => [a.slug, { ...a, built_in: true, active: 1 }]));
  for (const a of own) bySlug.set(a.slug, { slug: a.slug, title: a.title, body: a.body, codes: JSON.parse(a.codes || '[]'), active: a.active, built_in: false, overrides: bySlug.has(a.slug) });
  return [...bySlug.values()];
}

export const articlesForCodes = (library, codes) => library.filter((a) => a.active && codes.some((c) => a.codes.some((p) => c.startsWith(p))));
