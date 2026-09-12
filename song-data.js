// Navigation starts a fresh audio graph; song state never leaks across tracks.
async function getJSON(path) {
  const response = await fetch(`${path}?v=27`);
  if (!response.ok) throw new Error(`Song data: ${response.status}`);
  return response.json();
}
export const CATALOG = await getJSON('./catalog.json');
const requested = new URL(location.href).searchParams.get('song');
const entry = CATALOG.songs.find(song => song.id === requested)
  ?? CATALOG.songs.find(song => song.id === CATALOG.defaultSong);
if (!entry) throw new Error('No songs in catalog');
export const SONG_ID = entry.id;
export const SONG = await getJSON(entry.data);
