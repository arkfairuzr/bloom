import { useEffect, useState } from "react";
import { cleanArtist, cleanTitle } from "./lyrics";

// Some players hand Windows no artwork. Look the track up in the iTunes Search
// API (free, no key) so the music views still get a cover.
const cache = new Map<string, string | null>();

async function lookup(title: string, artist: string, signal: AbortSignal): Promise<string | null> {
	try {
		const term = encodeURIComponent(`${artist} ${title}`.trim());
		const res = await fetch(
			`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=3`,
			{ signal }
		);
		if (!res.ok) return null;
		const body: { results?: { artistName?: string; artworkUrl100?: string }[] } = await res.json();
		const wanted = artist.toLowerCase();
		// Take a hit whose artist matches, so a similarly named song cannot bring a wrong cover.
		const hit = body.results?.find((r) => {
			const name = (r.artistName ?? "").toLowerCase();
			return !!r.artworkUrl100 && (!wanted || name.includes(wanted) || wanted.includes(name));
		});
		return hit?.artworkUrl100 ? hit.artworkUrl100.replace("100x100bb", "300x300bb") : null;
	} catch {
		return null;
	}
}

/** A cover for the current track, or null while none is known. Only looks while `enabled`. */
export function useFallbackArt(rawTitle: string, rawArtist: string, enabled: boolean): string | null {
	const [url, setUrl] = useState<string | null>(null);
	const title = cleanTitle(rawTitle);
	const artist = cleanArtist(rawArtist);

	useEffect(() => {
		if (!enabled || !title) {
			setUrl(null);
			return;
		}
		const key = `${artist}|${title}`.toLowerCase();
		if (cache.has(key)) {
			setUrl(cache.get(key) ?? null);
			return;
		}
		setUrl(null);
		const controller = new AbortController();
		lookup(title, artist, controller.signal).then((found) => {
			if (controller.signal.aborted) return;
			cache.set(key, found);
			setUrl(found);
		});
		return () => controller.abort();
	}, [title, artist, enabled]);

	return url;
}
