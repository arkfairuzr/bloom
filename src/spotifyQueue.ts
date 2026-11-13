import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

// Spotify exposes the play queue only through its Web API, which needs the user's
// sign-in. The user brings their own (free) Spotify app: its client id is stored
// here and the sign-in is the PKCE flow, so no secret is needed.
const PORT = 43821;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = "user-read-playback-state user-read-currently-playing";

const KEY_CLIENT = "bloom-spotify-client-id";
const KEY_TOKENS = "bloom-spotify-tokens";

export interface QueueTrack {
	id: string;
	title: string;
	artist: string;
	image: string | null;
	isVideo: boolean;
}

export interface QueueState {
	current: QueueTrack | null;
	next: QueueTrack[];
}

interface Tokens {
	access: string;
	refresh: string;
	expiresAt: number;
}

const read = (key: string) => {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
};
const write = (key: string, value: string | null) => {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		/* storage unavailable */
	}
};

export const getClientId = () => read(KEY_CLIENT) ?? "";
export const setClientId = (id: string) => write(KEY_CLIENT, id.trim() || null);

function loadTokens(): Tokens | null {
	try {
		const raw = read(KEY_TOKENS);
		return raw ? (JSON.parse(raw) as Tokens) : null;
	} catch {
		return null;
	}
}
const saveTokens = (tokens: Tokens | null) => write(KEY_TOKENS, tokens ? JSON.stringify(tokens) : null);

export const isConnected = () => loadTokens() !== null;
export const disconnect = () => saveTokens(null);

const base64Url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function randomString(length: number): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return base64Url(bytes).slice(0, length);
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
	const res = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params)
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body.access_token) {
		throw new Error(body.error_description ?? body.error ?? `Spotify answered ${res.status}`);
	}
	return {
		access: body.access_token,
		refresh: body.refresh_token ?? loadTokens()?.refresh ?? "",
		expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60_000
	};
}

/** Signs in through the browser: opens Spotify's page and waits for the redirect. */
export async function connect(clientId: string): Promise<void> {
	const id = clientId.trim();
	if (!id) throw new Error("Enter your Spotify client id first");
	setClientId(id);

	const verifier = randomString(96);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = base64Url(new Uint8Array(digest));
	const state = randomString(16);

	const waiting = invoke<string>("spotify_auth_listen", { port: PORT });
	const url =
		"https://accounts.spotify.com/authorize?" +
		new URLSearchParams({
			client_id: id,
			response_type: "code",
			redirect_uri: SPOTIFY_REDIRECT_URI,
			scope: SCOPES,
			code_challenge_method: "S256",
			code_challenge: challenge,
			state
		});
	// Give the listener a moment to start before the browser can redirect to it.
	await new Promise((resolve) => setTimeout(resolve, 150));
	await openUrl(url);

	const query = new URLSearchParams(await waiting);
	if (query.get("error")) throw new Error(`Spotify: ${query.get("error")}`);
	if (query.get("state") !== state) throw new Error("Spotify sign-in didn't match; try again");
	const code = query.get("code");
	if (!code) throw new Error("Spotify sent no code");

	saveTokens(
		await tokenRequest({
			client_id: id,
			grant_type: "authorization_code",
			code,
			redirect_uri: SPOTIFY_REDIRECT_URI,
			code_verifier: verifier
		})
	);
}

async function accessToken(): Promise<string> {
	const tokens = loadTokens();
	if (!tokens) throw new Error("Spotify isn't connected");
	if (Date.now() < tokens.expiresAt) return tokens.access;
	const fresh = await tokenRequest({
		client_id: getClientId(),
		grant_type: "refresh_token",
		refresh_token: tokens.refresh
	});
	saveTokens(fresh);
	return fresh.access;
}

interface ApiTrack {
	id?: string;
	name?: string;
	type?: string;
	artists?: { name: string }[];
	show?: { name: string; images?: { url: string }[] };
	album?: { images?: { url: string }[] };
	images?: { url: string }[];
}

function toTrack(item: ApiTrack | null): QueueTrack | null {
	if (!item?.name) return null;
	const images = item.album?.images ?? item.show?.images ?? item.images ?? [];
	// A small cover is plenty for a row; the API lists them largest first.
	const image = images.length > 0 ? images[Math.min(1, images.length - 1)].url : null;
	return {
		id: item.id ?? item.name,
		title: item.name,
		artist: item.artists?.map((a) => a.name).join(", ") ?? item.show?.name ?? "",
		image,
		isVideo: item.type === "episode"
	};
}

export async function fetchQueue(): Promise<QueueState> {
	const token = await accessToken();
	const res = await fetch("https://api.spotify.com/v1/me/player/queue", {
		headers: { Authorization: `Bearer ${token}` }
	});
	if (res.status === 401) {
		// A revoked or stale sign-in: forget it so the panel offers to connect again.
		saveTokens(null);
		throw new Error("Spotify sign-in expired");
	}
	if (res.status === 204) return { current: null, next: [] };
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error?.message ?? `Spotify answered ${res.status}`);
	}
	const body: { currently_playing?: ApiTrack | null; queue?: ApiTrack[] } = await res.json();
	return {
		current: toTrack(body.currently_playing ?? null),
		next: (body.queue ?? []).map(toTrack).filter((t): t is QueueTrack => t !== null).slice(0, 30)
	};
}

/** The queue while `active`, refreshed every few seconds. */
export function useSpotifyQueue(active: boolean, connectedKey: number) {
	const [queue, setQueue] = useState<QueueState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);

	const refresh = useCallback(async () => {
		if (!isConnected()) return;
		try {
			const next = await fetchQueue();
			if (!alive.current) return;
			setQueue(next);
			setError(null);
		} catch (e) {
			if (alive.current) setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		if (!active) return;
		void refresh();
		const id = setInterval(() => void refresh(), 6000);
		return () => {
			alive.current = false;
			clearInterval(id);
		};
	}, [active, connectedKey, refresh]);

	return { queue, error, refresh };
}
