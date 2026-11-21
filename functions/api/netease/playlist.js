import { playlistResponse } from "../../../scripts/lib/netease-playlist-http.mjs";

export function onRequest({ request }) {
  return playlistResponse(request);
}
