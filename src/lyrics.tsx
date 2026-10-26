import { useEffect, useRef, useState } from "react";

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
function cleanArtist(artist: string): string {
	return artist.replace(/\s*-\s*Topic$/i, "").trim();
}

function cleanTitle(title: string): string {
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

async function fetchSynced(
	title: string,
	artist: string,
	durationMs: number,
	signal: AbortSignal
): Promise<LyricRow[] | null> {
	const params = new URLSearchParams({ track_name: title, artist_name: artist });
	if (durationMs > 0) params.set("duration", String(Math.round(durationMs / 1000)));
	try {
		const res = await fetch(`${LRCLIB}/get?${params}`, { signal });
		if (res.ok) {
			const body = await res.json();
			if (typeof body.syncedLyrics === "string" && body.syncedLyrics) {
				return parseLrc(body.syncedLyrics);
			}
		}
		// No exact match: take the first search hit that has synced lyrics.
		const search = await fetch(
			`${LRCLIB}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`,
			{ signal }
		);
		if (!search.ok) return null;
		const hits: { syncedLyrics?: string | null }[] = await search.json();
		const hit = hits.find((h) => h.syncedLyrics);
		return hit?.syncedLyrics ? parseLrc(hit.syncedLyrics) : null;
	} catch {
		return null;
	}
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
		fetchSynced(title, artist, duration, controller.signal).then((found) => {
			if (controller.signal.aborted) return;
			cache.set(key, found && found.length > 0 ? found : null);
			setRows(found && found.length > 0 ? found : null);
		});
		return () => controller.abort();
		// The duration only sharpens the match; a late value must not refetch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [title, artist, enabled]);

	return rows;
}

/** The line being sung right now, or null before the first line and without lyrics. */
export function useActiveLyric(
	rows: LyricRow[] | null,
	media: LyricsMedia,
	isPlaying: boolean,
	active: boolean
): string | null {
	const [line, setLine] = useState<string | null>(null);
	const mediaRef = useRef(media);
	mediaRef.current = media;

	useEffect(() => {
		if (!rows || !active) {
			setLine(null);
			return;
		}
		const tick = () => {
			const m = mediaRef.current;
			const elapsed = isPlaying ? Date.now() - (m.position_updated_at || Date.now()) : 0;
			const pos = (m.position_ms ?? 0) + elapsed + LEAD_MS;
			let current: string | null = null;
			for (const row of rows) {
				if (row.time > pos) break;
				current = row.text;
			}
			setLine(current || null);
		};
		tick();
		const id = setInterval(tick, 200);
		return () => clearInterval(id);
	}, [rows, isPlaying, active]);

	return line;
}
