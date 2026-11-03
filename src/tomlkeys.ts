// Maps celer `configure` CLI flags to their TOML config keys, prefixed with the
// parent section so they read like the on-disk celer.toml (e.g.
// `--pkgcache-keep-artifact-count` -> `pkgcache.keep_artifact_count`).
const FLAG_TO_TOML: Record<string, string> = {
    // [main]
    'platform': 'main.platform',
    'project': 'main.project',
    'build-type': 'main.build_type',
    'jobs': 'main.jobs',
    'offline': 'main.offline',
    'verbose': 'main.verbose',
    'downloads': 'main.downloads',
    // [pkgcache]
    'pkgcache-fs-dir': 'pkgcache.fs.dir',
    'pkgcache-minio-host': 'pkgcache.minio.host',
    'pkgcache-minio-access-key': 'pkgcache.minio.access_key',
    'pkgcache-minio-secret-key': 'pkgcache.minio.secret_key',
    'pkgcache-readonly': 'pkgcache.readonly',
    'pkgcache-keep-artifact-count': 'pkgcache.keep_artifact_count',
    // [proxy]
    'proxy-host': 'proxy.host',
    'proxy-port': 'proxy.port',
    // [ccache]
    'ccache-enabled': 'ccache.enabled',
    'ccache-dir': 'ccache.dir',
    'ccache-maxsize': 'ccache.maxsize',
    'ccache-remote-storage': 'ccache.remote_storage',
    'ccache-remote-only': 'ccache.remote_only',
};

/**
 * Resolve a configure flag (with or without leading `--`) to its TOML key path.
 * Unknown flags fall back to the stripped flag name.
 */
export function tomlKeyOf(flag: string): string {
    const stripped = flag.replace(/^--/, '');
    return FLAG_TO_TOML[stripped] ?? stripped;
}
