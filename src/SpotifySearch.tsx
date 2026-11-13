import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Search } from "lucide-react";
import { addToQueue, isConnected, playTrack, searchTracks, type QueueTrack } from "./spotifyQueue";
import "./SpotifySearch.css";

interface SpotifySearchProps {
	/** Opens the queue page, where Spotify is connected. */
	onNeedConnect: () => void;
}

// Pending release of the keyboard focus taken for the search field.
let blurTimer: number | undefined;

/**
 * A song search for the music panel's header: type, then play a result or add it to
 * the queue. It uses the same Spotify sign-in as the queue page.
 */
export function SpotifySearch({ onNeedConnect }: SpotifySearchProps) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<QueueTrack[]>([]);
	const [open, setOpen] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const requestId = useRef(0);

	useEffect(() => {
		const text = query.trim();
		if (text.length < 2) {
			setResults([]);
			setMessage(null);
			setLoading(false);
			return;
		}
		if (!isConnected()) {
			setResults([]);
			return;
		}
		const id = ++requestId.current;
		setLoading(true);
		const timer = window.setTimeout(() => {
			searchTracks(text)
				.then((found) => {
					if (id !== requestId.current) return;
					setResults(found);
					setMessage(found.length === 0 ? "No songs found" : null);
				})
				.catch((e) => {
					if (id !== requestId.current) return;
					setResults([]);
					setMessage(e instanceof Error ? e.message : String(e));
				})
				.finally(() => {
					if (id === requestId.current) setLoading(false);
				});
		}, 350);
		return () => window.clearTimeout(timer);
	}, [query]);

	const finish = (note: string) => {
		setQuery("");
		setResults([]);
		setMessage(note);
		window.setTimeout(() => setMessage(null), 2200);
	};

	const act = async (task: () => Promise<void>, done: string) => {
		try {
			await task();
			finish(done);
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
	};

	const showDropdown = open && (query.trim().length >= 2 || message !== null);
	const connected = isConnected();

	return (
		<div className="ss" onClick={(e) => e.stopPropagation()}>
			<div className="ss-field">
				<Search size={12} strokeWidth={2.4} />
				<input
					ref={inputRef}
					type="text"
					placeholder="Search songs"
					value={query}
					spellCheck={false}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Escape") {
							setQuery("");
							setOpen(false);
							inputRef.current?.blur();
						}
					}}
					// The notch never takes keyboard focus by itself; ask for it while typing.
					onFocus={(e) => {
						setOpen(true);
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
			</div>

			{showDropdown && (
				<div className="ss-results" onMouseDown={(e) => e.preventDefault()}>
					{!connected ? (
						<div className="ss-note">
							Connect Spotify to search.{" "}
							<button type="button" className="ss-link" onClick={onNeedConnect}>
								Open queue
							</button>
						</div>
					) : (
						<>
							{results.map((track) => (
								<div
									key={track.uri || track.id}
									className="ss-row"
									title="Play now"
									onClick={() => void act(() => playTrack(track.uri), "Playing")}
								>
									<div className="ss-cover">
										{track.image && <img src={track.image} alt="" draggable={false} />}
									</div>
									<div className="ss-text">
										<span className="ss-title">{track.title}</span>
										<span className="ss-artist">{track.artist}</span>
									</div>
									<button
										type="button"
										className="ss-add"
										title="Add to queue"
										aria-label="Add to queue"
										onClick={(e) => {
											e.stopPropagation();
											void act(() => addToQueue(track.uri), "Added to queue");
										}}
									>
										<Plus size={14} strokeWidth={2.5} />
									</button>
								</div>
							))}
							{loading && results.length === 0 && <div className="ss-note">Searching…</div>}
							{message && <div className="ss-note">{message}</div>}
						</>
					)}
				</div>
			)}
		</div>
	);
}
