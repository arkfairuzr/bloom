import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileUp, X } from "lucide-react";
import "./FileePanel.css";

interface FileePanelProps {
	files: string[];
	onFilesChange: (files: string[]) => void;
}

// Formats shown first; the rest follow in Filee's own order.
const PRIORITY = [
	"png",
	"jpg",
	"webp",
	"pdf",
	"docx",
	"xlsx",
	"pptx",
	"txt",
	"mp4",
	"mp3",
	"gif",
	"wav",
	"flac",
	"zip"
];

const extOf = (path: string) => (path.split(".").pop() ?? "").toLowerCase();
const nameOf = (path: string) => path.split("\\").pop()?.split("/").pop() ?? path;
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")));

function prioritize(targets: string[]): string[] {
	const rank = (t: string) => {
		const i = PRIORITY.indexOf(t.toLowerCase());
		return i === -1 ? PRIORITY.length : i;
	};
	return [...targets].sort((a, b) => rank(a) - rank(b));
}

/**
 * The notch's Filee page: put files in, pick a format, and Filee (its command line)
 * converts them. Results are saved beside the originals.
 */
export function FileePanel({ files, onFilesChange }: FileePanelProps) {
	const [targets, setTargets] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<{ target: string; done: number } | null>(null);
	const [outputs, setOutputs] = useState<string[]>([]);

	// The formats every chosen file can become.
	const extensions = useMemo(() => [...new Set(files.map(extOf).filter(Boolean))].slice(0, 6), [files]);
	useEffect(() => {
		setOutputs([]);
		setError(null);
		if (extensions.length === 0) {
			setTargets(null);
			return;
		}
		let active = true;
		setTargets(null);
		Promise.all(
			extensions.map((ext) =>
				invoke<string[]>("filee_targets", { path: `x.${ext}` }).then((list) => new Set(list))
			)
		)
			.then((sets) => {
				if (!active) return;
				const common = [...sets[0]].filter((t) => sets.every((s) => s.has(t)));
				setTargets(prioritize(common));
			})
			.catch((e) => {
				if (!active) return;
				setError(String(e));
				setTargets([]);
			});
		return () => {
			active = false;
		};
	}, [extensions]);

	const chooseFiles = async () => {
		try {
			const { open } = await import("@tauri-apps/plugin-dialog");
			const picked = await open({ multiple: true, title: "Choose files to convert" });
			const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
			if (paths.length > 0) onFilesChange([...new Set([...files, ...paths])]);
		} catch (e) {
			setError(String(e));
		}
	};

	const convert = async (target: string) => {
		if (busy) return;
		setError(null);
		setOutputs([]);
		const made: string[] = [];
		let failed: string | null = null;
		for (let i = 0; i < files.length; i++) {
			setBusy({ target, done: i });
			try {
				made.push(...(await invoke<string[]>("filee_convert", { path: files[i], to: target })));
			} catch (e) {
				failed = `${nameOf(files[i])}: ${String(e).slice(0, 90)}`;
			}
		}
		setBusy(null);
		setOutputs(made);
		if (failed) setError(failed);
	};

	const shown = files.slice(0, 4);

	return (
		<div className="fp">
			{files.length === 0 ? (
				<div className="fp-empty">
					<FileUp size={22} strokeWidth={1.8} />
					<span className="fp-empty-title">Drop files here to convert</span>
					<button type="button" className="fp-button" onClick={chooseFiles}>
						Choose files
					</button>
					{error && <span className="fp-error">{error}</span>}
				</div>
			) : (
				<>
					<div className="fp-files">
						{shown.map((path) => (
							<span className="fp-file" key={path} title={path}>
								{nameOf(path)}
								<button
									type="button"
									aria-label="Remove"
									onClick={() => onFilesChange(files.filter((p) => p !== path))}
								>
									<X size={10} strokeWidth={2.5} />
								</button>
							</span>
						))}
						{files.length > shown.length && (
							<span className="fp-file fp-more">+{files.length - shown.length}</span>
						)}
						<button type="button" className="fp-link" onClick={chooseFiles}>
							Add
						</button>
						<button type="button" className="fp-link" onClick={() => onFilesChange([])}>
							Clear
						</button>
					</div>

					<div className="fp-row">
						<span className="fp-label">Convert to</span>
						{targets === null ? (
							<span className="fp-wait">…</span>
						) : targets.length === 0 ? (
							<span className="fp-wait">No common format</span>
						) : (
							<div className="fp-chips">
								{targets.map((target) => (
									<button
										key={target}
										type="button"
										className="fp-chip"
										disabled={!!busy}
										onClick={() => convert(target)}
									>
										{busy?.target === target ? `${busy.done + 1}/${files.length}` : target.toUpperCase()}
									</button>
								))}
							</div>
						)}
					</div>

					<div className="fp-status">
						{error ? (
							<span className="fp-error">{error}</span>
						) : outputs.length > 0 ? (
							<>
								<span>Saved {outputs.length === 1 ? nameOf(outputs[0]) : `${outputs.length} files`}</span>
								<button
									type="button"
									className="fp-link"
									onClick={() => invoke("shelf_open", { path: dirOf(outputs[0]) }).catch(() => {})}
								>
									Show folder
								</button>
							</>
						) : (
							<span className="fp-hint">Results are saved next to the originals</span>
						)}
					</div>
				</>
			)}
		</div>
	);
}
