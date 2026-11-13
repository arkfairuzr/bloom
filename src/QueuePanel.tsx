import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import {
	SPOTIFY_REDIRECT_URI,
	connect,
	disconnect,
	getClientId,
	isConnected,
	needsReconnect,
	skipTo,
	useSpotifyQueue,
	type QueueTrack
} from "./spotifyQueue";
import "./QueuePanel.css";

interface QueuePanelProps {
	onClose: () => void;
	/** The playing track's title: a change refreshes the list at once. */
	trackTitle: string;
}

// Pending release of the keyboard focus taken for the client id field.
let blurTimer: number | undefined;

function Row({
	track,
	playing,
	onPlay,
	busy
}: {
	track: QueueTrack;
	playing?: boolean;
	onPlay?: () => void;
	busy?: boolean;
}) {
	return (
		<div
			className={`sq-row${onPlay ? " clickable" : ""}${busy ? " busy" : ""}`}
			title={onPlay ? "Play this song" : undefined}
			onClick={onPlay}
		>
			<div className="sq-cover">{track.image && <img src={track.image} alt="" draggable={false} />}</div>
			<div className="sq-text">
				<span className={`sq-title${playing ? " playing" : ""}`}>{track.title}</span>
				<span className="sq-artist">
					{track.isVideo ? "Episode · " : ""}
					{track.artist}
				</span>
			</div>
		</div>
	);
}

/**
 * Spotify's play queue as a page of the music panel: the track now playing and
 * what comes next. It needs a one-time sign-in with the user's own Spotify app.
 */
export function QueuePanel({ onClose, trackTitle }: QueuePanelProps) {
	const [connectedKey, setConnectedKey] = useState(0);
	const connected = isConnected();
	const { queue, error, refresh } = useSpotifyQueue(connected, connectedKey);
	const [clientId, setClientIdText] = useState(getClientId);
	const [busy, setBusy] = useState(false);
	const [setupError, setSetupError] = useState<string | null>(null);
	const [skipping, setSkipping] = useState<number | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	useEffect(() => {
		if (connected) void refresh();
	}, [trackTitle, connected, refresh]);

	const signIn = async () => {
		setBusy(true);
		setSetupError(null);
		try {
			await connect(clientId);
			setConnectedKey((k) => k + 1);
		} catch (e) {
			setSetupError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const play = async (index: number) => {
		if (skipping !== null) return;
		setSkipping(index);
		setActionError(null);
		try {
			await skipTo(index);
			await refresh();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : String(e));
		} finally {
			setSkipping(null);
		}
	};

	return (
		<div className="sq" onClick={(e) => e.stopPropagation()}>
			<div className="sq-head">
				<span className="sq-heading">Queue</span>
				<button type="button" className="sq-close" aria-label="Close queue" onClick={onClose}>
					<X size={14} strokeWidth={2.5} />
				</button>
			</div>

			{!connected ? (
				<div className="sq-setup">
					<span className="sq-setup-title">Connect Spotify to see the queue</span>
					<ol>
						<li>
							Create an app at{" "}
							<button
								type="button"
								className="sq-link"
								onClick={() => openUrl("https://developer.spotify.com/dashboard")}
							>
								developer.spotify.com/dashboard
							</button>
						</li>
						<li>
							Add this redirect URI: <code>{SPOTIFY_REDIRECT_URI}</code>
						</li>
						<li>Paste the app's client id below</li>
					</ol>
					<div className="sq-field">
						<input
							type="text"
							placeholder="Client id"
							value={clientId}
							spellCheck={false}
							onChange={(e) => setClientIdText(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							// The notch never takes keyboard focus by itself; ask for it while typing.
							onFocus={(e) => {
								window.clearTimeout(blurTimer);
								const input = e.currentTarget;
								invoke("set_input_focus", { label: "main", active: true })
									.catch(() => {})
									.finally(() => input.focus());
							}}
							onBlur={(e) => {
								const input = e.currentTarget;
								blurTimer = window.setTimeout(() => {
									if (document.activeElement === input) return;
									invoke("set_input_focus", { label: "main", active: false }).catch(() => {});
								}, 200);
							}}
						/>
						<button type="button" className="sq-connect" disabled={busy} onClick={signIn}>
							{busy ? "Waiting…" : "Connect"}
						</button>
					</div>
					{setupError && <span className="sq-error">{setupError}</span>}
				</div>
			) : (
				<div className="sq-scroll">
					{error && <span className="sq-error">{error}</span>}
					{actionError && <span className="sq-error">{actionError}</span>}
					{needsReconnect() && (
						<span className="sq-error">
							To choose songs here, sign in to Spotify again.{" "}
							<button type="button" className="sq-link" disabled={busy} onClick={signIn}>
								Reconnect
							</button>
						</span>
					)}
					{queue?.current && (
						<>
							<div className="sq-section">Now playing</div>
							<Row track={queue.current} playing />
						</>
					)}
					<div className="sq-section">Next up</div>
					{queue === null ? (
						<span className="sq-empty">Loading…</span>
					) : queue.next.length === 0 ? (
						<span className="sq-empty">Nothing queued. Play something in Spotify.</span>
					) : (
						queue.next.map((track, i) => (
							<Row
								key={`${track.id}-${i}`}
								track={track}
								busy={skipping !== null}
								onPlay={() => void play(i)}
							/>
						))
					)}
					<button
						type="button"
						className="sq-link sq-signout"
						onClick={() => {
							disconnect();
							setConnectedKey((k) => k + 1);
						}}
					>
						Disconnect Spotify
					</button>
				</div>
			)}
		</div>
	);
}
