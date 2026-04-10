// Package updater checks GitHub releases for a newer version of this binary,
// downloads it if available, replaces the current executable, and restarts.
// It is designed to run once at startup before the server begins accepting
// connections. No external tools (curl, wget, jq) are required — pure Go.
package updater

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"go.uber.org/zap"
)

const (
	// GitHub API endpoint for latest release
	apiURL = "https://api.github.com/repos/Beleg87/quipu/releases/latest"

	// Asset name pattern per platform
	assetWindows = "quipu-signaling-windows-amd64.exe"
	assetLinux   = "quipu-signaling-linux-amd64"

	httpTimeout = 30 * time.Second
)

// githubRelease is the subset of fields we need from the GitHub API response.
type githubRelease struct {
	TagName string `json:"tag_name"` // e.g. "v0.1.8"
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// CheckAndUpdate fetches the latest release from GitHub. If the remote version
// is newer than currentVersion, it downloads the appropriate asset, replaces
// the running binary, and returns true so the caller can restart the process.
// Returns false if already up to date or if any step fails (server continues).
func CheckAndUpdate(currentVersion string, log *zap.Logger) (shouldRestart bool) {
	log.Info("checking for updates", zap.String("current", currentVersion))

	client := &http.Client{Timeout: httpTimeout}

	// ── 1. Fetch latest release metadata ─────────────────────────────────────
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		log.Warn("update check failed: could not build request", zap.Error(err))
		return false
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "quipu-signaling/"+currentVersion)

	resp, err := client.Do(req)
	if err != nil {
		log.Warn("update check failed: GitHub unreachable", zap.Error(err))
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Warn("update check failed: unexpected status", zap.Int("code", resp.StatusCode))
		return false
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		log.Warn("update check failed: could not parse release JSON", zap.Error(err))
		return false
	}

	// ── 2. Compare versions ───────────────────────────────────────────────────
	latestVersion := strings.TrimPrefix(release.TagName, "v")
	current       := strings.TrimPrefix(currentVersion, "v")

	if latestVersion == "" {
		log.Warn("update check: no version tag in release")
		return false
	}
	if latestVersion == current {
		log.Info("already up to date", zap.String("version", currentVersion))
		return false
	}
	if !isNewer(latestVersion, current) {
		log.Info("already up to date", zap.String("version", currentVersion))
		return false
	}

	log.Info("new version available",
		zap.String("current", currentVersion),
		zap.String("latest", release.TagName))

	// ── 3. Find the right asset for this platform ─────────────────────────────
	wantAsset := assetLinux
	if runtime.GOOS == "windows" {
		wantAsset = assetWindows
	}

	var downloadURL string
	for _, asset := range release.Assets {
		if asset.Name == wantAsset {
			downloadURL = asset.BrowserDownloadURL
			break
		}
	}
	if downloadURL == "" {
		log.Warn("update: asset not found in release", zap.String("want", wantAsset))
		return false
	}

	log.Info("downloading update", zap.String("url", downloadURL))

	// ── 4. Download to a temp file beside the current binary ─────────────────
	exePath, err := os.Executable()
	if err != nil {
		log.Warn("update: could not determine executable path", zap.Error(err))
		return false
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		log.Warn("update: could not resolve symlinks", zap.Error(err))
		return false
	}

	dir  := filepath.Dir(exePath)
	tmpPath := filepath.Join(dir, wantAsset+".tmp")

	if err := downloadFile(client, downloadURL, tmpPath); err != nil {
		log.Warn("update: download failed", zap.Error(err))
		_ = os.Remove(tmpPath)
		return false
	}

	// ── 5. Make the downloaded file executable (Linux/macOS) ─────────────────
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpPath, 0755); err != nil {
			log.Warn("update: chmod failed", zap.Error(err))
			_ = os.Remove(tmpPath)
			return false
		}
	}

	// ── 6. Atomically replace the current binary ──────────────────────────────
	// On Windows we can't overwrite a running exe, so we rename it to .old
	// and put the new one in its place. On restart the .old file is cleaned up.
	if runtime.GOOS == "windows" {
		oldPath := exePath + ".old"
		_ = os.Remove(oldPath) // remove any previous .old
		if err := os.Rename(exePath, oldPath); err != nil {
			log.Warn("update: could not rename current exe", zap.Error(err))
			_ = os.Remove(tmpPath)
			return false
		}
	}

	if err := os.Rename(tmpPath, exePath); err != nil {
		log.Warn("update: could not replace binary", zap.Error(err))
		_ = os.Remove(tmpPath)
		return false
	}

	log.Info("update downloaded successfully",
		zap.String("version", release.TagName),
		zap.String("path", exePath))

	// Signal caller to restart
	return true
}

// CleanupOldBinary removes the .old backup left from a Windows update.
func CleanupOldBinary(log *zap.Logger) {
	if runtime.GOOS != "windows" {
		return
	}
	exePath, err := os.Executable()
	if err != nil {
		return
	}
	exePath, _ = filepath.EvalSymlinks(exePath)
	oldPath := exePath + ".old"
	if err := os.Remove(oldPath); err == nil {
		log.Info("cleaned up old binary", zap.String("path", oldPath))
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func downloadFile(client *http.Client, url, dest string) error {
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d downloading %s", resp.StatusCode, url)
	}
	f, err := os.Create(dest)
	if err != nil {
		return fmt.Errorf("create %s: %w", dest, err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return fmt.Errorf("write %s: %w", dest, err)
	}
	return nil
}

// isNewer returns true if a > b using simple semver comparison (major.minor.patch).
func isNewer(a, b string) bool {
	pa := parseSemver(a)
	pb := parseSemver(b)
	for i := range pa {
		if pa[i] > pb[i] {
			return true
		}
		if pa[i] < pb[i] {
			return false
		}
	}
	return false
}

func parseSemver(v string) [3]int {
	var major, minor, patch int
	fmt.Sscanf(v, "%d.%d.%d", &major, &minor, &patch)
	return [3]int{major, minor, patch}
}
