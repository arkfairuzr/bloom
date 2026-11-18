import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import "./MousePanel.css";

export interface ButtonMapping {
	mode: string;
	steps: string;
}

export interface MapperConfig {
	enabled: boolean;
	back: ButtonMapping;
	forward: ButtonMapping;
}

const SETTING_KEY = "bloom-mouse-mapper";

export const DEFAULT_MAPPER: MapperConfig = {
	enabled: true,
	back: { mode: "default", steps: "" },
	forward: { mode: "default", steps: "" }
};

const MODES: { id: string; label: string; hint: string; needsText?: boolean }[] = [
	{ id: "default", label: "Normal (unchanged)", hint: "The button keeps working as Back or Forward." },
	{ id: "copy", label: "Copy (Ctrl+C)", hint: "Copies the selected text or file." },
	{ id: "paste", label: "Paste (Ctrl+V)", hint: "Pastes what you copied." },
	{ id: "cut", label: "Cut (Ctrl+X)", hint: "Cuts the selection." },
	{ id: "undo", label: "Undo (Ctrl+Z)", hint: "Undoes the last action." },
	{
		id: "macro",
		label: "Keys / macro",
		hint: "Examples: f  |  ctrl+shift+esc  |  text:hello  |  ctrl+c;wait:200;ctrl+v",
		needsText: true
	},
	{
		id: "autoclick",
		label: "Auto-click while held",
		hint: "Milliseconds between clicks, e.g. 50. Clicks until you let go.",
		needsText: true
	},
	{ id: "disable", label: "Disabled", hint: "The button does nothing." }
];

export function loadMapperConfig(): MapperConfig {
	try {
		const raw = localStorage.getItem(SETTING_KEY);
		if (!raw) return DEFAULT_MAPPER;
		const parsed = JSON.parse(raw) as Partial<MapperConfig>;
		return {
			enabled: parsed.enabled ?? true,
			back: { ...DEFAULT_MAPPER.back, ...parsed.back },
			forward: { ...DEFAULT_MAPPER.forward, ...parsed.forward }
		};
	} catch {
		return DEFAULT_MAPPER;
	}
}

/** Sends the settings to the mouse hook and remembers them. */
export function applyMapperConfig(config: MapperConfig) {
	const text = JSON.stringify(config);
	try {
		localStorage.setItem(SETTING_KEY, text);
	} catch {
		/* storage unavailable */
	}
	invoke("save_setting", { key: SETTING_KEY, value: text }).catch(() => {});
	invoke("mouse_mapper_apply", { configIn: config }).catch(() => {});
}

// Pending release of the keyboard focus taken for the text fields.
let blurTimer: number | undefined;

function ModePicker({
	value,
	onChange
}: {
	value: string;
	onChange: (mode: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = MODES.find((m) => m.id === value) ?? MODES[0];
	return (
		<div className="mp-picker">
			<button type="button" className="mp-select" onClick={() => setOpen((o) => !o)}>
				<span>{current.label}</span>
				<ChevronDown size={12} strokeWidth={2.5} />
			</button>
			{open && (
				<div className="mp-options">
					{MODES.map((mode) => (
						<button
							key={mode.id}
							type="button"
							className={`mp-option${mode.id === value ? " on" : ""}`}
							onClick={() => {
								onChange(mode.id);
								setOpen(false);
							}}
						>
							{mode.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function ButtonColumn({
	title,
	mapping,
	onChange
}: {
	title: string;
	mapping: ButtonMapping;
	onChange: (next: ButtonMapping) => void;
}) {
	const mode = MODES.find((m) => m.id === mapping.mode) ?? MODES[0];
	return (
		<div className="mp-column">
			<span className="mp-title">{title}</span>
			<ModePicker value={mapping.mode} onChange={(id) => onChange({ ...mapping, mode: id })} />
			<input
				type="text"
				className="mp-input"
				disabled={!mode.needsText}
				placeholder={mode.needsText ? (mode.id === "autoclick" ? "50" : "key or macro") : ""}
				value={mode.needsText ? mapping.steps : ""}
				spellCheck={false}
				onChange={(e) => onChange({ ...mapping, steps: e.target.value })}
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
			<span className="mp-hint">{mode.hint}</span>
		</div>
	);
}

/**
 * The notch's Mouse page: what the mouse's two side buttons do. The mapping itself runs in
 * the backend (src-tauri/src/mouse_mapper.rs) for as long as Bloom is open.
 */
export function MousePanel() {
	const [config, setConfig] = useState<MapperConfig>(loadMapperConfig);
	const [last, setLast] = useState(0);
	const skipFirst = useRef(true);

	// Every change goes to the hook and is saved; the first render only reads.
	useEffect(() => {
		if (skipFirst.current) {
			skipFirst.current = false;
			return;
		}
		applyMapperConfig(config);
	}, [config]);

	// Shows which side button was pressed last, to tell the two apart.
	useEffect(() => {
		const id = window.setInterval(() => {
			invoke<number>("mouse_mapper_last_button")
				.then(setLast)
				.catch(() => {});
		}, 400);
		return () => window.clearInterval(id);
	}, []);

	return (
		<div className="mp">
			<div className="mp-columns">
				<ButtonColumn
					title="Back button"
					mapping={config.back}
					onChange={(back) => setConfig((c) => ({ ...c, back }))}
				/>
				<div className="mp-divider" />
				<ButtonColumn
					title="Forward button"
					mapping={config.forward}
					onChange={(forward) => setConfig((c) => ({ ...c, forward }))}
				/>
			</div>
			<div className="mp-footer">
				<label className="mp-toggle">
					<input
						type="checkbox"
						checked={config.enabled}
						onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
					/>
					<span>Mapping on</span>
				</label>
				<span className="mp-last">
					Last pressed: {last === 1 ? "Back" : last === 2 ? "Forward" : "-"}
				</span>
			</div>
		</div>
	);
}
