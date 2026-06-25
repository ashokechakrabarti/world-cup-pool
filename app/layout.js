import "./globals.css";

// Customize these for your group.
export const metadata = {
  title: "Group of Death — World Cup 2026 Pool",
  description: "A FIFA World Cup 2026 tiered-draft pool for your group.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
