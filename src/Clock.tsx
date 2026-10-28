import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { EdgeSurface } from "./components/EdgeSurface";
import { initTheme } from "./theme";
import "./Clock.css";

const appWindow = getCurrentWebviewWindow();

/**
 * A small always-on-top clock at the right edge (vertically centred, where the
 * brightness HUD used to be). It only shows while the notch is tucked away in
 * smart/peek mode; the notch itself shows the time when it is out.
 */
function ClockApp() {
	const [now, setNow] = useState(() => new Date());
	const [notchHidden, setNotchHidden] = useState(false);
	const [enabled, setEnabled] = useState(
		() => localStorage.getItem("bloom-clock-hud-enabled") !== "false"
	);
	const [use24h, setUse24h] = useState(
		() => localStorage.getItem("bloom-time-format-24h") === "true"
	);
	const [shown, setShown] = useState(false);
	const visible = enabled && notchHidden;

	useEffect(() => initTheme(), []);

	// The window is only a transparent frame for the card: let every click through.
	useEffect(() => {
		invoke("set_ignore_cursor_events", { ignore: true }).catch(() => {});
	}, []);

	useEffect(() => {
		invoke<Record<string, unknown>>("load_settings")
			.then((settings) => {
				if (settings["bloom-clock-hud-enabled"] !== undefined) {
					setEnabled(settings["bloom-clock-hud-enabled"] !== "false");
				}
				if (settings["bloom-time-format-24h"] !== undefined) {
					setUse24h(settings["bloom-time-format-24h"] === "true");
				}
			})
			.catch(() => {});
	}, []);

	useSettingsSync({
		"bloom-clock-hud-enabled": setEnabled,
		"bloom-time-format-24h": setUse24h
	});

	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 1000);
		return () => clearInterval(id);
	}, []);

	// The notch window reports whether it is tucked away.
	useEffect(() => {
		const unlisten = listen<boolean>("notch-hidden-state", (event) => {
			setNotchHidden(Boolean(event.payload));
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		let hideTimer: ReturnType<typeof setTimeout> | undefined;
		if (visible) {
			(async () => {
				await invoke("position_clock_window");
				await appWindow.show();
				setShown(true);
			})().catch(() => {});
		} else {
			setShown(false);
			// Let the card slide out before the window goes away.
			hideTimer = setTimeout(() => appWindow.hide().catch(() => {}), 350);
		}
		return () => clearTimeout(hideTimer);
	}, [visible]);

	const time = useMemo(() => {
		const hours = now.getHours();
		return {
			hour: use24h ? String(hours).padStart(2, "0") : String(hours % 12 || 12),
			minute: String(now.getMinutes()).padStart(2, "0"),
			suffix: use24h ? "" : hours >= 12 ? "PM" : "AM"
		};
	}, [now, use24h]);

	const date = useMemo(
		() => ({
			weekday: now.toLocaleDateString(undefined, { weekday: "short" }),
			day: String(now.getDate()),
			month: now.toLocaleDateString(undefined, { month: "short" })
		}),
		[now]
	);

	return (
		<div className="clock-root">
			<div className={`clock-card ${shown ? "shown" : ""}`}>
				<EdgeSurface edge="right" flares={false} />
				<span className="clock-hour">{time.hour}</span>
				<span className="clock-minute">{time.minute}</span>
				{time.suffix && <span className="clock-suffix">{time.suffix}</span>}
				<div className="clock-date">
					<span className="clock-weekday">{date.weekday}</span>
					<span className="clock-day">{date.day}</span>
					<span className="clock-month">{date.month}</span>
				</div>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<ClockApp />
	</StrictMode>
);
