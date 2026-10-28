// The page around the checker: header, footer and the mark. brand/ holds the mark as files.

const SOURCE_URL = "https://github.com/remedcu/safe-state-check"

// The content column. The header and footer use the same width, so their edges line up with the page's.
export const PAGE = "mx-auto w-full max-w-[65rem] px-4 sm:px-8"

const EXTERNAL = { target: "_blank", rel: "noreferrer noopener" } as const

// Two lines across and two down, a square on each crossing: the frame of the design system's slides, at icon size.
export function Mark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d="M0 7.5H24M0 16.5H24M7.5 0V24M16.5 0V24" fill="none" strokeWidth="1.5" className="stroke-brand-deep" />
      <path d="M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM14 14h5v5h-5z" className="fill-brand" />
    </svg>
  )
}

export function SiteHeader() {
  return (
    <header className="border-b border-border-subtle">
      <div className={`${PAGE} flex h-16 items-center justify-between gap-4`}>
        <h1 className="text-[17px] leading-6 font-semibold">
          {/* The start page: a link from this site carries the Safe in the #, so this one starts empty. */}
          <a href="/" className="flex items-center gap-3">
            <Mark className="size-6" />
            Safe State Check
          </a>
        </h1>
        <a href={SOURCE_URL} {...EXTERNAL} className="text-sm text-muted-foreground hover:text-foreground">
          Source on GitHub
        </a>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-border-subtle">
      <div className={`${PAGE} flex flex-wrap justify-between gap-x-12 gap-y-6 py-10 text-sm`}>
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-3 text-base font-semibold">
            <Mark className="size-5" />
            Safe State Check
          </p>
          <a href={SOURCE_URL} {...EXTERNAL} className="text-brand hover:text-foreground">
            Source on GitHub
          </a>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground">
            Built by <span className="font-semibold text-foreground">Shebin John</span>
          </p>
          <p className="flex gap-5">
            <a href="https://x.com/shebitweet" {...EXTERNAL} className="text-brand hover:text-foreground">
              X
            </a>
            <a href="https://www.linkedin.com/in/shebinjohn" {...EXTERNAL} className="text-brand hover:text-foreground">
              LinkedIn
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}
