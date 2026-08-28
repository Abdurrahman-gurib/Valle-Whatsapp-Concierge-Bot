/**
 * IMAGE LIBRARY — park photos the bot can share on WhatsApp.
 *
 * Source: source-material/original-images (AVIF/WebP), converted once to JPEG
 * in assets/photos (WhatsApp accepts JPEG/PNG only). Each topic lists
 * its best photos first. Uploads are cached by file for reuse (~30 days).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadMedia, sendImage } from '../whatsapp/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'assets', 'photos');

export const IMAGES = {
  park: [
    { file: 'home-overview.jpg', caption: 'Vallé · Advenature Park™, Chamouny. The 23 Coloured Earth seen from above.' },
    { file: 'trail-viewpoint.jpg', caption: 'Viewpoints over the south of Mauritius along the walking trail.' },
    { file: 'trail-reception.jpg', caption: 'Your Advenature starts at reception.' },
  ],
  ziplines: [
    { file: 'zipline-superman.jpg', caption: 'The Signature zipline, 1.5 km, superman style over the valley.' },
    { file: 'zipline-waterfall.jpg', caption: 'Ziplining past the waterfalls.' },
    { file: 'zipline-tandem.jpg', caption: 'Tandem flight over the canopy.' },
    { file: 'zipline-duo.jpg', caption: 'Side by side over the 23 Coloured Earth.' },
  ],
  bicycle: [
    { file: 'bicycle-sky.jpg', caption: 'The Bicycle Zipline: pedal 18 m above the ground.' },
    { file: 'bicycle-joy.jpg', caption: 'Unique in Mauritius: the Bicycle Zipline.' },
    { file: 'bicycle-pair.jpg', caption: 'Bicycle Zipline over the lake.' },
  ],
  bridge: [
    { file: 'bridge-span.jpg', caption: 'The Nepalese Bridge: 350 m, up to 100 m above the ground.' },
    { file: 'bridge-family.jpg', caption: 'Families crossing the Nepalese Bridge.' },
    { file: 'bridge-couple.jpg', caption: 'From dense forest to open coastal views.' },
  ],
  quad: [
    { file: 'quad-earth.jpg', caption: 'Quad trails across the 23 Coloured Earth.' },
    { file: 'quad-river.jpg', caption: 'River crossings on the Adventure Track.' },
    { file: 'quad-convoy.jpg', caption: 'Guided quad convoy through the park.' },
    { file: 'quad-duo.jpg', caption: 'Two-seater quads for sharing the ride.' },
  ],
  buggy: [
    { file: 'frame-1872-1.jpg', caption: 'Buggy Discovery Tour: room for two adults and a little explorer.' },
    { file: 'buggy-earth.jpg', caption: 'Buggy at the 23 Coloured Earth.' },
    { file: 'buggy-forest.jpg', caption: 'Buggy trails through the forest.' },
    { file: 'buggy-river.jpg', caption: 'Splashing through the river by buggy.' },
  ],
  luge: [
    { file: 'luge-race.jpg', caption: 'Mountain Luge Kart: you control the speed.' },
    { file: 'luge-family.jpg', caption: 'Luge Kart, family-friendly from 1 m 10.' },
    { file: 'luge-duo-curve.jpg', caption: 'Every curve brings a new burst of excitement.' },
  ],
  expedition: [
    { file: 'expedition-raptor-ocean.jpg', caption: "Explorer's Drive: 4x4 expedition with ocean views." },
    { file: 'expedition-convoy-lookout.jpg', caption: 'Guided expedition to the lookouts.' },
    { file: 'expedition-guide-guests.jpg', caption: 'Our guides share the hidden wonders of the park.' },
  ],
  peak: [
    { file: 'peak-view.jpg', caption: 'The Peak: from Mahebourg\'s coastline to Le Morne.' },
    { file: 'peak-tower.jpg', caption: 'The Peak, highest point of the southern mountains.' },
    { file: 'peak-bench.jpg', caption: 'A quiet moment at The Peak.' },
  ],
  nature: [
    { file: 'coloured-earth.jpg', caption: 'The 23 Coloured Earth: a geological masterpiece found nowhere else.' },
    { file: 'valle-giant-tortoise-park-mauritius.jpg', caption: 'Giant tortoises roam the park.' },
    { file: 'endemictrees.jpg', caption: 'Over 50 species of endemic trees.' },
    { file: 'rock-garden-trail.jpg', caption: 'The Rock Garden, a haven of tranquility.' },
  ],
  waterfalls: [
    { file: 'chamouze-waterfall.jpg', caption: 'Chamouzé waterfall.' },
    { file: 'vacoas-waterfall.jpg', caption: 'Vacoas waterfall.' },
    { file: 'valle-waterfall-nature-trail-mauritius.jpg', caption: 'Waterfalls along the nature trail.' },
  ],
  kids: [
    { file: 'outdoorplayground.jpg', caption: 'Vallé Kids Park: where play meets discovery.' },
    { file: 'pirateship.jpg', caption: 'The pirate ship at the Kids Park.' },
    { file: 'miniquad.jpg', caption: 'Mini quads for young adventurers.' },
    { file: 'rollercoast.jpg', caption: 'Roller coaster zipline fun for the family.' },
  ],
  dining: [
    { file: 'chamouze-restaurant.jpg', caption: 'Le Chamouzé: dine beside the waterfall.' },
    { file: 'lechamouze.jpg', caption: 'Le Chamouzé, our signature restaurant.' },
    { file: 'la-citronelle-4.jpg', caption: 'Indian and Mauritian cuisine at La Bigarade.' },
    { file: 'kazbonbon.jpg', caption: 'Kaz Bonbon: sweets for the little ones (and the big ones).' },
  ],
  animals: [
    { file: 'valle-giant-tortoise-park-mauritius.jpg', caption: 'Our giant tortoises, always happy to meet guests.' },
    { file: 'trail-tortoise.jpg', caption: 'Meeting a giant tortoise along the walking trail.' },
    { file: 'animalpark.jpg', caption: 'Wild Java deer roam freely across the park.' },
    { file: 'endemictrees.jpg', caption: 'Over 50 species of endemic trees shelter the wildlife.' },
  ],
  history: [
    { file: 'coloured-earth.jpg', caption: 'It began here: 23 hues of Mauritian soil discovered on a family tea plantation.' },
    { file: 'valle-waterfall-nature-trail-mauritius.jpg', caption: 'A natural path to a waterfall became the first quad trail.' },
    { file: 'zipline-superman.jpg', caption: 'Ocean views inspired the ziplines, now up to 5.5 km.' },
    { file: 'home-overview.jpg', caption: 'Today: Vallé · Advenature Park™, born of nature, made for adventure.' },
  ],
  map: [
    { file: 'park-sitemap.jpg', caption: 'Vallé walking trail map: your trail starts at reception.' },
  ],
};

export const IMAGE_TOPICS = Object.keys(IMAGES);
export const hasImages = (topic) => Array.isArray(IMAGES[topic]) && IMAGES[topic].length > 0;

const mediaCache = new Map(); // file -> media id

async function mediaIdFor(file, force = false) {
  if (!force && mediaCache.has(file)) return mediaCache.get(file);
  const id = await uploadMedia(fs.readFileSync(path.join(DIR, file)), 'image/jpeg');
  mediaCache.set(file, id);
  return id;
}

/** Send one photo for a topic (index picks which); caption defaults to the photo's own. */
export async function sendPhoto(to, topic, { index = 0, caption } = {}) {
  const list = IMAGES[topic];
  if (!list?.length) return false;
  const img = list[index % list.length];
  const text = caption ?? img.caption;
  try {
    await sendImage(to, { id: await mediaIdFor(img.file), caption: text });
  } catch {
    // Media ids expire: re-upload once and retry.
    await sendImage(to, { id: await mediaIdFor(img.file, true), caption: text });
  }
  return true;
}

/** Send up to n photos of a topic, one message each. */
export async function sendGallery(to, topic, n = 3) {
  const list = IMAGES[topic] || IMAGES.park;
  for (let i = 0; i < Math.min(n, list.length); i++) {
    await sendPhoto(to, topic in IMAGES ? topic : 'park', { index: i });
  }
}
