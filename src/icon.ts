// TextFold's logo as an Obsidian icon: three rounded bars of decreasing length, as in TextFold's reader (LOGO in its
// reader.js), drawn in currentColor so it takes the colour of where it is (a callout's, a link's). Registered with
// addIcon, it is the [!textfold] callout's --callout-icon and the icon of a ↗ link back to TextFold.

export const ICON = "textfold-logo";

// addIcon's 100 × 100 box: the reader's 20 × 20 bars, five times as large
export const ICON_SVG =
	'<rect x="10" y="15" width="80" height="12" rx="6" fill="currentColor" stroke="none"/>' +
	'<rect x="10" y="44" width="55" height="12" rx="6" fill="currentColor" fill-opacity="0.55" stroke="none"/>' +
	'<rect x="10" y="73" width="25" height="12" rx="6" fill="currentColor" stroke="none"/>';
