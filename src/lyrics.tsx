import { useEffect, useState } from "react";

export interface LyricsMedia {
	title: string;
	artist: string;
	duration_ms?: number;
	position_ms?: number;
	position_updated_at?: number;
}

export interface LyricRow {
	time: number;
	text: string;
}

// Lyrics come from LRCLIB (https://lrclib.net), a free community database of
// time-synced lyrics that needs no account or key.
const LRCLIB = "https://lrclib.net/api";
// Show a line slightly early so it is readable when the singer starts it.
export const LEAD_MS = 250;

const cache = new Map<string, LyricRow[] | null>();

export function lyricsEnabled(): boolean {
	try {
		return localStorage.getItem("bloom-lyrics-enabled") !== "false";
	} catch {
		return true;
	}
}

// "Artist - Topic" is how YouTube Music names auto-generated artist channels.
export function cleanArtist(artist: string): string {
	return artist.replace(/\s*-\s*Topic$/i, "").trim();
}

export function cleanTitle(title: string): string {
	return title
		.replace(/\s*[(\[](official|lyrics?|audio|video|music video|visualizer|hd|4k)[^)\]]*[)\]]/gi, "")
		.trim();
}

export function parseLrc(lrc: string): LyricRow[] {
	const rows: LyricRow[] = [];
	for (const line of lrc.split(/\r?\n/)) {
		const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
		if (stamps.length === 0) continue;
		const text = line.replace(/\[[^\]]*\]/g, "").trim();
		for (const s of stamps) {
			rows.push({ time: (Number(s[1]) * 60 + Number(s[2])) * 1000, text });
		}
	}
	return rows.sort((a, b) => a.time - b.time);
}

interface LrclibHit {
	duration?: number;
	syncedLyrics?: string | null;
}

// The best hit that has synced lyrics: one whose length is within a few seconds of
// the track's when it is known, otherwise the first.
function pickSynced(hits: LrclibHit[], durationMs: number): LyricRow[] | null {
	const synced = hits.filter((h) => h.syncedLyrics);
	if (synced.length === 0) return null;
	const close =
		durationMs > 0
			? synced.find((h) => h.duration && Math.abs(h.duration * 1000 - durationMs) <= 4000)
			: undefined;
	const rows = parseLrc((close ?? synced[0]).syncedLyrics as string);
	return rows.length > 0 ? rows : null;
}

/**
 * Looks the track up on LRCLIB, from the exact match to ever looser searches.
 * `settled` is false when a request failed, so the miss is not remembered.
 */
async function fetchSynced(
	title: string,
	artist: string,
	durationMs: number,
	signal: AbortSignal
): Promise<{ rows: LyricRow[] | null; settled: boolean }> {
	let settled = true;
	const getJson = async (url: string): Promise<unknown> => {
		try {
			const res = await fetch(url, { signal });
			if (res.ok) return await res.json();
			if (res.status !== 404) settled = false;
		} catch {
			settled = false;
		}
		return null;
	};

	const exact = new URLSearchParams({ track_name: title, artist_name: artist });
	if (durationMs > 0) exact.set("duration", String(Math.round(durationMs / 1000)));
	const hit = (await getJson(`${LRCLIB}/get?${exact}`)) as LrclibHit | null;
	if (hit?.syncedLyrics) {
		const rows = parseLrc(hit.syncedLyrics);
		if (rows.length > 0) return { rows, settled };
	}

	const searches = [
		new URLSearchParams({ track_name: title, artist_name: artist }),
		new URLSearchParams({ q: `${artist} ${title}`.trim() }),
		new URLSearchParams({ q: title })
	];
	for (const query of searches) {
		if (signal.aborted) break;
		const hits = (await getJson(`${LRCLIB}/search?${query}`)) as LrclibHit[] | null;
		const rows = Array.isArray(hits) ? pickSynced(hits, durationMs) : null;
		if (rows) return { rows, settled };
	}
	return { rows: null, settled };
}

export function useLyricRows(media: LyricsMedia, enabled: boolean): LyricRow[] | null {
	const [rows, setRows] = useState<LyricRow[] | null>(null);
	const title = cleanTitle(media.title);
	const artist = cleanArtist(media.artist);
	const duration = media.duration_ms ?? 0;

	useEffect(() => {
		if (!enabled || !title) {
			setRows(null);
			return;
		}
		const key = `${artist}|${title}`.toLowerCase();
		if (cache.has(key)) {
			setRows(cache.get(key) ?? null);
			return;
		}
		setRows(null);
		const controller = new AbortController();
		fetchSynced(title, artist, duration, controller.signal).then(({ rows: found, settled }) => {
			if (controller.signal.aborted) return;
			// A failed request is not remembered, so the next visit tries again.
			if (settled || found) cache.set(key, found);
			setRows(found);
		});
		return () => controller.abort();
		// The duration only sharpens the match; a late value must not refetch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [title, artist, enabled]);

	return rows;
}
