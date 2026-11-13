import { useEffect, useState } from "react";

// The notch's ambient glow blurs, saturates and brightens the album cover (see
// .notch-ambient-glow in App.css). Measure the cover the same way to choose the
// text colour that reads best on it, and how much of a light or dark veil the
// background needs so that the text keeps enough contrast everywhere.
const SAMPLE = 16;
// WCAG's contrast ratio for body text.
const TARGET_CONTRAST = 4.5;
const DARK_TEXT = 0.012; // relative luminance of the dark text colour
const WHITE_TEXT = 1;
const MAX_VEIL = 0.55;
const DARK_BIAS = 1.25;

export interface ArtContrast {
	/** True when the text should be dark. */
	light: boolean;
	/** Opacity of a veil (white behind dark text, black behind white text); 0 when none is needed. */
	scrim: number;
}

const NEUTRAL: ArtContrast = { light: false, scrim: 0 };
const cache = new Map<string, ArtContrast>();

const channel = (v: number) => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function decide(luminances: number[]): ArtContrast {
	const sorted = [...luminances].sort((a, b) => a - b);
	// Percentiles rather than extremes, so a few stray pixels do not decide it.
	const dark = sorted[Math.floor(sorted.length * 0.1)];
	const bright = sorted[Math.floor(sorted.length * 0.9)];

	const contrastWhite = (WHITE_TEXT + 0.05) / (bright + 0.05); // worst case: the brightest area
	const contrastDark = (dark + 0.05) / (DARK_TEXT + 0.05); // worst case: the darkest area
	// White text is the default look; dark text has to be clearly better to replace it.
	const useDark = contrastDark > contrastWhite * DARK_BIAS;

	if (useDark) {
		if (contrastDark >= TARGET_CONTRAST) return { light: true, scrim: 0 };
		// Lighten the darkest area until the dark text reads on it.
		const needed = TARGET_CONTRAST * (DARK_TEXT + 0.05) - 0.05;
		const alpha = (needed - dark) / (1 - dark);
		return { light: true, scrim: Math.min(MAX_VEIL, Math.max(0, alpha)) };
	}
	if (contrastWhite >= TARGET_CONTRAST) return { light: false, scrim: 0 };
	// Darken the brightest area until the white text reads on it.
	const allowed = (WHITE_TEXT + 0.05) / TARGET_CONTRAST - 0.05;
	const alpha = 1 - allowed / bright;
	return { light: false, scrim: Math.min(MAX_VEIL, Math.max(0, alpha)) };
}

function measure(url: string): Promise<ArtContrast> {
	return new Promise((resolve) => {
		const img = new Image();
		if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
		img.onload = () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = SAMPLE;
				canvas.height = SAMPLE;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return resolve(NEUTRAL);
				ctx.filter = "saturate(3.5) contrast(1.1) brightness(1.4)";
				// The glow shows the middle of the cover, enlarged.
				const w = img.naturalWidth;
				const h = img.naturalHeight;
				ctx.drawImage(img, w * 0.2, h * 0.2, w * 0.6, h * 0.6, 0, 0, SAMPLE, SAMPLE);
				const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
				const luminances: number[] = [];
				for (let i = 0; i < data.length; i += 4) {
					luminances.push(
						0.2126 * channel(data[i]) + 0.7152 * channel(data[i + 1]) + 0.0722 * channel(data[i + 2])
					);
				}
				resolve(decide(luminances));
			} catch {
				// A cover from another origin can taint the canvas; assume dark.
				resolve(NEUTRAL);
			}
		};
		img.onerror = () => resolve(NEUTRAL);
		img.src = url;
	});
}

/** The text colour and background veil that keep the music panel readable over this cover. */
export function useArtContrast(url: string | null): ArtContrast {
	const [contrast, setContrast] = useState<ArtContrast>(NEUTRAL);

	useEffect(() => {
		if (!url) {
			setContrast(NEUTRAL);
			return;
		}
		const cached = cache.get(url);
		if (cached) {
			setContrast(cached);
			return;
		}
		let active = true;
		measure(url).then((result) => {
			if (cache.size > 40) cache.clear();
			cache.set(url, result);
			if (active) setContrast(result);
		});
		return () => {
			active = false;
		};
	}, [url]);

	return contrast;
}
