import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import {
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	Download,
	Eye,
	EyeOff,
	File,
	FileArchive,
	FileAudio,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	FileVideo,
	Folder,
	HardDrive,
	Image as ImageIcon,
	Monitor,
	Music,
	Palette,
	Search,
	Star,
	Video,
	X
} from "lucide-react";
import "./Files.css";

const appWindow = getCurrentWebviewWindow();

interface FsEntry {
	name: string;
	path: string;
	is_dir: boolean;
	size: number;
	modified: number | null;
}

interface Place {
	name: string;
	path: string;
	kind: "folder" | "drive";
}

interface Favorite {
	name: string;
	path: string;
}

interface FilesConfig {
	opacity: number;
	mono_icons: boolean;
	show_hidden: boolean;
	favorites: Favorite[];
}

type IconKind =
	| "folder"
	| "drive"
	| "image"
	| "video"
	| "audio"
	| "sheet"
	| "doc"
	| "archive"
	| "code"
	| "file";

const EXTENSIONS: Record<string, IconKind> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	svg: "image",
	heic: "image",
	mp4: "video",
	mkv: "video",
	mov: "video",
	avi: "video",
	webm: "video",
	mp3: "audio",
	wav: "audio",
	flac: "audio",
	m4a: "audio",
	ogg: "audio",
	xlsx: "sheet",
	xls: "sheet",
	xlsm: "sheet",
	csv: "sheet",
	pdf: "doc",
	doc: "doc",
	docx: "doc",
	ppt: "doc",
	pptx: "doc",
	txt: "doc",
	md: "doc",
	zip: "archive",
	rar: "archive",
	"7z": "archive",
	tar: "archive",
	gz: "archive",
	js: "code",
	ts: "code",
	tsx: "code",
	json: "code",
	html: "code",
	css: "code",
	py: "code",
	rs: "code"
};

function kindOf(entry: FsEntry): IconKind {
	if (entry.is_dir) return "folder";
	const dot = entry.name.lastIndexOf(".");
	if (dot < 0) return "file";
	return EXTENSIONS[entry.name.slice(dot + 1).toLowerCase()] ?? "file";
}

function KindIcon({ kind, size = 16 }: { kind: IconKind; size?: number }) {
	const props = { size, strokeWidth: 1.6, className: `ico k-${kind}` };
	switch (kind) {
		case "folder":
			return <Folder {...props} />;
		case "drive":
			return <HardDrive {...props} />;
		case "image":
			return <FileImage {...props} />;
		case "video":
			return <FileVideo {...props} />;
		case "audio":
			return <FileAudio {...props} />;
		case "sheet":
			return <FileSpreadsheet {...props} />;
		case "doc":
			return <FileText {...props} />;
		case "archive":
			return <FileArchive {...props} />;
		case "code":
			return <FileCode {...props} />;
		default:
			return <File {...props} />;
	}
}

function PlaceIcon({ place }: { place: Place }) {
	const props = { size: 15, strokeWidth: 1.6, className: "ico k-place" };
	if (place.kind === "drive") return <HardDrive {...props} />;
	switch (place.name) {
		case "Desktop":
			return <Monitor {...props} />;
		case "Downloads":
			return <Download {...props} />;
		case "Pictures":
			return <ImageIcon {...props} />;
		case "Music":
			return <Music {...props} />;
		case "Videos":
			return <Video {...props} />;
		case "Documents":
			return <FileText {...props} />;
		default:
			return <Folder {...props} />;
	}
}

// ---- path helpers (Windows paths) ----

function trimSlash(path: string): string {
	return path.length > 3 ? path.replace(/[\\/]+$/, "") : path;
}

function isRoot(path: string): boolean {
	return /^[A-Za-z]:[\\/]?$/.test(path);
}

function parentOf(path: string): string | null {
	const p = trimSlash(path);
	if (isRoot(p)) return null;
	const cut = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
	if (cut < 0) return null;
	const parent = p.slice(0, cut);
	return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

function crumbsOf(path: string): { label: string; path: string }[] {
	const p = trimSlash(path);
	const parts = p.split(/[\\/]+/).filter(Boolean);
	const crumbs: { label: string; path: string }[] = [];
	let acc = "";
	parts.forEach((part, i) => {
		acc = i === 0 ? `${part}\\` : `${acc.replace(/[\\/]+$/, "")}\\${part}`;
		crumbs.push({ label: part, path: acc });
	});
	return crumbs;
}

function baseName(path: string): string {
	const crumbs = crumbsOf(path);
	return crumbs.length ? crumbs[crumbs.length - 1].label : path;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(ms: number | null): string {
	if (ms === null) return "";
	return new Date(ms).toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit"
	});
}

function FilesApp() {
	const [config, setConfig] = useState<FilesConfig>({
		opacity: 60,
		mono_icons: true,
		show_hidden: false,
		favorites: []
	});
	const [places, setPlaces] = useState<Place[]>([]);
	const [history, setHistory] = useState<string[]>([]);
	const [cursor, setCursor] = useState(-1);
	const [entries, setEntries] = useState<FsEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const configRef = useRef(config);
	configRef.current = config;

	const path = cursor >= 0 ? history[cursor] : null;

	// ---- startup ----
	useEffect(() => {
		const preventContext = (e: MouseEvent) => e.preventDefault();
		document.addEventListener("contextmenu", preventContext);
		return () => document.removeEventListener("contextmenu", preventContext);
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [cfg, found] = await Promise.all([
					invoke<FilesConfig>("files_get_config"),
					invoke<Place[]>("files_places")
				]);
				if (cancelled) return;
				setConfig(cfg);
				setPlaces(found);
				const start =
					cfg.favorites[0]?.path ??
					found.find((p) => p.name === "Documents")?.path ??
					found[0]?.path ??
					null;
				if (start) {
					setHistory([start]);
					setCursor(0);
				}
			} catch (e) {
				setError(String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// ---- listing ----
	useEffect(() => {
		if (!path) return;
		let cancelled = false;
		setLoading(true);
		invoke<FsEntry[]>("files_list_dir", { path, showHidden: config.show_hidden })
			.then((list) => {
				if (cancelled) return;
				setEntries(list);
				setError(null);
				setSelected(null);
				setQuery("");
			})
			.catch((e) => {
				if (cancelled) return;
				setEntries([]);
				setError(String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path, config.show_hidden]);

	const visible = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries
			.filter((e) => !needle || e.name.toLowerCase().includes(needle))
			.sort((a, b) => {
				if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
				return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
			});
	}, [entries, query]);

	// ---- navigation ----
	const go = useCallback(
		(target: string) => {
			if (target === path) return;
			setHistory((h) => [...h.slice(0, cursor + 1), target]);
			setCursor((c) => c + 1);
		},
		[path, cursor]
	);

	const back = useCallback(() => setCursor((c) => (c > 0 ? c - 1 : c)), []);
	const forward = useCallback(
		() => setCursor((c) => (c < history.length - 1 ? c + 1 : c)),
		[history.length]
	);
	const up = useCallback(() => {
		const parent = path ? parentOf(path) : null;
		if (parent) go(parent);
	}, [path, go]);

	const openEntry = useCallback(
		(entry: FsEntry) => {
			if (entry.is_dir) go(entry.path);
			else invoke("files_open", { path: entry.path }).catch((e) => setError(String(e)));
		},
		[go]
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
			if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
				e.preventDefault();
				back();
			} else if (e.altKey && e.key === "ArrowRight") {
				e.preventDefault();
				forward();
			} else if (e.altKey && e.key === "ArrowUp") {
				e.preventDefault();
				up();
			} else if (e.key === "Enter" && selected) {
				const entry = visible.find((v) => v.path === selected);
				if (entry) openEntry(entry);
			} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				const index = visible.findIndex((v) => v.path === selected);
				const next = e.key === "ArrowDown" ? index + 1 : index - 1;
				const target = visible[Math.min(Math.max(next, 0), visible.length - 1)];
				if (target) setSelected(target.path);
			} else if (e.key === "Escape") {
				appWindow.hide().catch(() => {});
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [back, forward, up, openEntry, selected, visible]);

	// ---- settings ----
	const saveFavorites = (favorites: Favorite[]) => {
		setConfig((c) => ({ ...c, favorites }));
		invoke("files_set_favorites", { favorites }).catch(console.error);
	};

	const isFavorite = path ? config.favorites.some((f) => f.path === path) : false;

	const toggleFavorite = () => {
		if (!path) return;
		if (isFavorite) saveFavorites(config.favorites.filter((f) => f.path !== path));
		else saveFavorites([...config.favorites, { name: baseName(path), path }]);
	};

	const setFlag = (name: "mono_icons" | "show_hidden", value: boolean) => {
		setConfig((c) => ({ ...c, [name]: value }));
		invoke("files_set_flag", { name, value }).catch(console.error);
	};

	// The darkness is drawn by CSS (see --tint), so dragging is instant; the value
	// is only saved when the slider is released.
	const changeOpacity = (value: number, save: boolean) => {
		setConfig((c) => ({ ...c, opacity: value }));
		if (save) invoke("files_set_opacity", { opacity: value }).catch(console.error);
	};

	const crumbs = path ? crumbsOf(path) : [];
	const canBack = cursor > 0;
	const canForward = cursor < history.length - 1;
	const canUp = path ? parentOf(path) !== null : false;

	return (
		<div
			className={`files ${config.mono_icons ? "mono" : ""}`}
			style={{ "--tint": config.opacity / 100 } as React.CSSProperties}
		>
			<div className="titlebar" data-tauri-drag-region>
				<span className="title" data-tauri-drag-region>
					Files
				</span>
				<div className="title-tools">
					<label className="opacity" title="Glass opacity">
						<span className="opacity-label">Opacity</span>
						<input
							type="range"
							min={5}
							max={100}
							value={config.opacity}
							style={{ "--fill": `${((config.opacity - 5) / 95) * 100}%` } as React.CSSProperties}
							onChange={(e) => changeOpacity(Number(e.target.value), false)}
							onPointerUp={(e) => changeOpacity(Number((e.target as HTMLInputElement).value), true)}
							onKeyUp={(e) => changeOpacity(Number((e.target as HTMLInputElement).value), true)}
						/>
						<span className="opacity-value">{config.opacity}%</span>
					</label>
					<button
						className={`tool ${config.mono_icons ? "on" : ""}`}
						title="Black & white icons"
						onClick={() => setFlag("mono_icons", !config.mono_icons)}
					>
						<Palette size={14} strokeWidth={1.6} />
					</button>
					<button
						className={`tool ${config.show_hidden ? "on" : ""}`}
						title={config.show_hidden ? "Hide hidden files" : "Show hidden files"}
						onClick={() => setFlag("show_hidden", !config.show_hidden)}
					>
						{config.show_hidden ? <Eye size={14} strokeWidth={1.6} /> : <EyeOff size={14} strokeWidth={1.6} />}
					</button>
					<button className="tool close" title="Close" onClick={() => appWindow.hide()}>
						<X size={14} strokeWidth={1.6} />
					</button>
				</div>
			</div>

			<div className="body">
				<aside className="sidebar">
					{config.favorites.length > 0 && (
						<section>
							<h4>Favorites</h4>
							{config.favorites.map((fav) => (
								<div
									key={fav.path}
									className={`side-item ${path === fav.path ? "active" : ""}`}
									onClick={() => go(fav.path)}
									title={fav.path}
								>
									<Star size={15} strokeWidth={1.6} className="ico k-place" />
									<span>{fav.name}</span>
									<button
										className="side-remove"
										title="Remove from favorites"
										onClick={(e) => {
											e.stopPropagation();
											saveFavorites(config.favorites.filter((f) => f.path !== fav.path));
										}}
									>
										<X size={12} strokeWidth={1.8} />
									</button>
								</div>
							))}
						</section>
					)}
					<section>
						<h4>Places</h4>
						{places
							.filter((p) => p.kind === "folder")
							.map((place) => (
								<div
									key={place.path}
									className={`side-item ${path === place.path ? "active" : ""}`}
									onClick={() => go(place.path)}
									title={place.path}
								>
									<PlaceIcon place={place} />
									<span>{place.name}</span>
								</div>
							))}
					</section>
					<section>
						<h4>Drives</h4>
						{places
							.filter((p) => p.kind === "drive")
							.map((place) => (
								<div
									key={place.path}
									className={`side-item ${path === place.path ? "active" : ""}`}
									onClick={() => go(place.path)}
									title={place.path}
								>
									<PlaceIcon place={place} />
									<span>{place.name}</span>
								</div>
							))}
					</section>
				</aside>

				<main className="main">
					<div className="toolbar">
						<button className="nav" onClick={back} disabled={!canBack} title="Back">
							<ChevronLeft size={16} strokeWidth={1.8} />
						</button>
						<button className="nav" onClick={forward} disabled={!canForward} title="Forward">
							<ChevronRight size={16} strokeWidth={1.8} />
						</button>
						<button className="nav" onClick={up} disabled={!canUp} title="Up one folder">
							<ArrowUp size={15} strokeWidth={1.8} />
						</button>
						<div className="crumbs">
							{crumbs.map((crumb, i) => (
								<span key={crumb.path} className="crumb-wrap">
									{i > 0 && <ChevronRight size={12} strokeWidth={1.8} className="crumb-sep" />}
									<button className="crumb" onClick={() => go(crumb.path)}>
										{crumb.label}
									</button>
								</span>
							))}
						</div>
						<button
							className={`nav ${isFavorite ? "star-on" : ""}`}
							onClick={toggleFavorite}
							title={isFavorite ? "Remove from favorites" : "Add to favorites"}
							disabled={!path}
						>
							<Star size={15} strokeWidth={1.6} />
						</button>
						<div className="search">
							<Search size={13} strokeWidth={1.6} />
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Filter"
								spellCheck={false}
							/>
						</div>
					</div>

					<div className="list-head">
						<span className="c-name">Name</span>
						<span className="c-date">Modified</span>
						<span className="c-size">Size</span>
					</div>

					<div className="list">
						{error && <div className="notice error">{error}</div>}
						{!error && !loading && visible.length === 0 && (
							<div className="notice">{query ? "No matches" : "This folder is empty"}</div>
						)}
						{visible.map((entry) => (
							<div
								key={entry.path}
								className={`row ${selected === entry.path ? "selected" : ""}`}
								onClick={() => setSelected(entry.path)}
								onDoubleClick={() => openEntry(entry)}
								title={entry.name}
							>
								<span className="c-name">
									<KindIcon kind={kindOf(entry)} />
									<span className="name-text">{entry.name}</span>
								</span>
								<span className="c-date">{formatDate(entry.modified)}</span>
								<span className="c-size">{entry.is_dir ? "" : formatSize(entry.size)}</span>
							</div>
						))}
					</div>

					<div className="status">
						{visible.length} {visible.length === 1 ? "item" : "items"}
						{selected ? ` · ${baseName(selected)}` : ""}
					</div>
				</main>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<FilesApp />
	</StrictMode>
);
