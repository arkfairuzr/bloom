import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { MusicNoteIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "./icons";
import { LEAD_MS, type LyricRow, type LyricsMedia } from "./lyrics";
import "./LyricsPlayer.css";

interface LyricsPlayerProps {
	media: LyricsMedia & { seek_enabled?: boolean };
	albumArtUrl: string | null;
	albumArtKey: number;
	isPlaying: boolean;
	rows: LyricRow[];
	onTogglePlayPause: () => void;
	onPrev: () => void;
	onNext: () => void;
}

// How many lines show above and below the one being sung.
const CONTEXT_LINES = 2;

function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

/**
 * The music panel when lyrics exist: artwork and title on the left, a few lines
 * of lyrics with the current one highlighted on the right, controls underneath.
 */
export function LyricsPlayer({
	media,
	albumArtUrl,
	albumArtKey,
	isPlaying,
	rows,
	onTogglePlayPause,
	onPrev,
	onNext
}: LyricsPlayerProps) {
	const duration = media.duration_ms ?? 0;
	const mediaRef = useRef(media);
	mediaRef.current = media;
	const seekingRef = useRef(false);
	const [position, setPosition] = useState(0);

	// The backend reports the position about once a second; extrapolate between reports.
	useEffect(() => {
		const tick = () => {
			if (seekingRef.current) return;
			const m = mediaRef.current;
			const elapsed = isPlaying ? Date.now() - (m.position_updated_at || Date.now()) : 0;
			const pos = (m.position_ms ?? 0) + elapsed;
			setPosition(duration > 0 ? Math.min(pos, duration) : pos);
		};
		tick();
		const id = setInterval(tick, 200);
		return () => clearInterval(id);
	}, [isPlaying, duration]);

	let active = -1;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i].time > position + LEAD_MS) break;
		active = i;
	}

	const lines: { index: number; text: string; offset: number }[] = [];
	for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES; offset++) {
		const index = active + offset;
		const text = index >= 0 && index < rows.length ? rows[index].text : "";
		lines.push({ index: index, text, offset });
	}

	const onSeekEnd = useCallback(() => {
		seekingRef.current = false;
		invoke("media_seek", { positionMs: Math.round(mediaRef.current.position_ms ?? 0) }).catch(() => {});
	}, []);

	const percent = duration > 0 ? (position / duration) * 100 : 0;

	return (
		<div className="lyp">
			<div className="lyp-left">
				<div className="lyp-art">
					<AnimatePresence mode="wait" initial={false}>
						{albumArtUrl ? (
							<motion.img
								key={`art-${albumArtKey}`}
								src={albumArtUrl}
								alt="Art"
								draggable={false}
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.2 }}
							/>
						) : (
							<div className="lyp-art-placeholder">
								<MusicNoteIcon size={30} />
							</div>
						)}
					</AnimatePresence>
				</div>
				<div className="lyp-title" title={media.title}>
					{media.title}
				</div>
				<div className="lyp-artist">{media.artist}</div>
			</div>

			<div className="lyp-divider" />

			<div className="lyp-right">
				<div className="lyp-lines">
					{lines.map((line) => (
						<motion.div
							key={`${line.index}`}
							layout="position"
							className={`lyp-line${line.offset === 0 ? " current" : ""}`}
							initial={{ opacity: 0 }}
							animate={{ opacity: line.offset === 0 ? 1 : 0.4 }}
							transition={{ duration: 0.25 }}
						>
							{line.text || " "}
						</motion.div>
					))}
				</div>

				<div className="lyp-controls">
					<button
						className="lyp-btn"
						onClick={(e) => {
							e.stopPropagation();
							onPrev();
						}}
					>
						<SkipBackIcon size={24} />
					</button>
					<button
						className="lyp-btn lyp-play"
						onClick={(e) => {
							e.stopPropagation();
							onTogglePlayPause();
						}}
					>
						{isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
					</button>
					<button
						className="lyp-btn"
						onClick={(e) => {
							e.stopPropagation();
							onNext();
						}}
					>
						<SkipForwardIcon size={24} />
					</button>
				</div>

				{duration > 0 && (
					<div className="lyp-progress">
						<span className="lyp-time">{formatClock(position)}</span>
						<div className="lyp-bar">
							<div className="lyp-bar-fill" style={{ width: `${percent}%` }} />
							{media.seek_enabled && (
								<input
									type="range"
									className="lyp-seek"
									min={0}
									max={duration}
									step={100}
									value={position}
									onMouseDown={() => {
										seekingRef.current = true;
									}}
									onChange={(e) => {
										const v = Number(e.target.value);
										setPosition(v);
										mediaRef.current = { ...mediaRef.current, position_ms: v, position_updated_at: Date.now() };
									}}
									onMouseUp={onSeekEnd}
									onClick={(e) => e.stopPropagation()}
								/>
							)}
						</div>
						<span className="lyp-time">-{formatClock(duration - position)}</span>
					</div>
				)}
			</div>
		</div>
	);
}
