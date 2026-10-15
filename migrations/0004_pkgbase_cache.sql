-- The AUR pkgbase for a package name. A split package's pkgname differs from
-- its repository name (the pkgbase), and cgit addresses repositories by
-- pkgbase, so the name must be resolved before a PKGBUILD or diff is fetched.
CREATE TABLE pkgbase_cache (
    name       TEXT PRIMARY KEY,
    pkgbase    TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
);
