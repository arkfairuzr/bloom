import { useEffect, useState } from "react";

// The notch's ambient glow blurs, saturates and brightens the album cover (see
// .notch-ambient-glow in App.css). Measure the cover the same way to learn whether
// the panel ends up bright enough that white text becomes hard to read.
const LIGHT_THRESHOLD = 0.5;
const SAMPLE = 24;
const cache = new Map<string, boolean>();

function measure(url: string): Promise<boolean> {
	return new Promise((resolve) => {
		const img = new Image();
		if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
		img.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = SAMPLE;
				canvas.height = SAMPLE;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return resolve(false);
				ctx.filter = "saturate(3.5) contrast(1.1) brightness(1.4)";
				ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
				const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
				let total = 0;
				for (let i = 0; i < data.length; i += 4) {
					total += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
				}
				resolve(total / (data.length / 4) > LIGHT_THRESHOLD);
			} catch {
				// A cover from another origin can taint the canvas; assume dark.
				resolve(false);
			}
		};
		img.onerror = () => resolve(false);
		img.src = url;
	});
}

/** Whether the glow made from this cover is light enough to need dark text. */
export function useArtIsLight(url: string | null): boolean {
	const [light, setLight] = useState(false);

	useEffect(() => {
		if (!url) {
			setLight(false);
			return;
		}
		const cached = cache.get(url);
		if (cached !== undefined) {
			setLight(cached);
			return;
		}
		let active = true;
		measure(url).then((result) => {
			if (cache.size > 40) cache.clear();
			cache.set(url, result);
			if (active) setLight(result);
		});
		return () => {
			active = false;
		};
	}, [url]);

	return light;
}
