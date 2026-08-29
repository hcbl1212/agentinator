/**
 * Agent prose rendered readably: line breaks survive (the container styles
 * white-space: pre-wrap) and ``` code fences become distinct blocks with any
 * language tag stripped. Deliberately not a markdown engine — headings and
 * bold stay literal, which reads fine; fences and newlines were what turned
 * transcripts into soup.
 */
export function FormattedText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split('```')
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="code-block">
            {part.replace(/^[a-zA-Z0-9_+-]*\n/, '')}
          </pre>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  )
}
