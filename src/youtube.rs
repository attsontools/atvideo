use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tokio::{process::Command, time::timeout};

use crate::ServiceError;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeVideoInfo {
    pub title: String,
    pub uploader: Option<String>,
    pub cover: Option<String>,
    pub duration: Option<i64>,
    pub video_url: Option<String>,
    pub subtitle_urls: Vec<SubtitleTrack>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    pub language: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct YoutubeRuntime {
    bridge: PathBuf,
    quickjs: PathBuf,
}

impl YoutubeRuntime {
    pub fn discover() -> Self {
        let directory = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(ToOwned::to_owned))
            .unwrap_or_else(|| PathBuf::from("."));
        let extension = if cfg!(windows) { ".exe" } else { "" };
        Self {
            bridge: std::env::var_os("ATVIDEO_YOUTUBE_BRIDGE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| directory.join(format!("youtube-bridge{extension}"))),
            quickjs: std::env::var_os("ATVIDEO_QUICKJS_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| directory.join(format!("qjs{extension}"))),
        }
    }

    #[cfg(test)]
    fn new(bridge: PathBuf, quickjs: PathBuf) -> Self {
        Self { bridge, quickjs }
    }
}

pub async fn extract_video(
    runtime: &YoutubeRuntime,
    url: &str,
    proxy: Option<&str>,
) -> Result<YoutubeVideoInfo, ServiceError> {
    if !runtime.bridge.is_file() || !runtime.quickjs.is_file() {
        return Err(ServiceError::new(
            "VIDEO_SERVICE_RUNTIME_UNAVAILABLE",
            "YouTube runtime is missing; reinstall or update AT Video",
        ));
    }
    let mut command = Command::new(&runtime.bridge);
    command
        .kill_on_drop(true)
        .arg("--youtube")
        .arg(url)
        .arg("--js-runtime")
        .arg(&runtime.quickjs);
    if let Some(proxy) = proxy.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("--proxy").arg(proxy);
    }
    let output = timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| runtime_failed("YouTube runtime timed out"))?
        .map_err(|_| runtime_failed("YouTube runtime could not start"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = if stderr.contains("Sign in") || stderr.contains("age restricted") {
            "YouTube 内容需要登录或存在年龄限制"
        } else if stderr.contains("HTTP Error 403") || stderr.contains("blocked") {
            "YouTube 请求被拒绝，请检查代理"
        } else {
            "YouTube runtime execution failed"
        };
        return Err(runtime_failed(message));
    }

    parse_video_json(&output.stdout)
        .map_err(|_| runtime_failed("YouTube runtime response is invalid"))
}

fn runtime_failed(message: &'static str) -> ServiceError {
    ServiceError::new("VIDEO_SERVICE_RUNTIME_EXECUTION_FAILED", message)
}

fn parse_video_json(output: &[u8]) -> Result<YoutubeVideoInfo, String> {
    let json: serde_json::Value =
        serde_json::from_slice(output).map_err(|error| format!("解析 yt-dlp 输出失败：{error}"))?;

    let title = json
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let uploader = json
        .get("uploader")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let cover = json
        .get("thumbnail")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let duration = json.get("duration").and_then(|v| v.as_i64());

    // Pick best mp4 (video+audio combined). yt-dlp -j gives `url` for best merged when possible.
    let video_url = json
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            // Fallback: iterate formats for best mp4 with audio
            json.get("formats")
                .and_then(|arr| arr.as_array())
                .and_then(|formats| {
                    formats.iter().rev().find_map(|f| {
                        let ext = f.get("ext").and_then(|v| v.as_str()).unwrap_or("");
                        let has_audio = f
                            .get("acodec")
                            .and_then(|v| v.as_str())
                            .map(|s| s != "none")
                            .unwrap_or(false);
                        let has_video = f
                            .get("vcodec")
                            .and_then(|v| v.as_str())
                            .map(|s| s != "none")
                            .unwrap_or(false);
                        if ext == "mp4" && has_audio && has_video {
                            f.get("url").and_then(|v| v.as_str()).map(str::to_string)
                        } else {
                            None
                        }
                    })
                })
        });

    // Subtitles: prefer manual, fall back to auto
    let mut subs: Vec<SubtitleTrack> = Vec::new();
    for source in ["subtitles", "automatic_captions"] {
        if let Some(map) = json.get(source).and_then(|v| v.as_object()) {
            for (lang, tracks) in map {
                if !matches!(
                    lang.as_str(),
                    "en" | "zh-Hans" | "zh-Hant" | "zh" | "zh-CN" | "zh-TW"
                ) {
                    continue;
                }
                if let Some(arr) = tracks.as_array() {
                    // Prefer vtt or srt over json3
                    if let Some(track) = arr.iter().find(|t| {
                        matches!(
                            t.get("ext").and_then(|v| v.as_str()).unwrap_or(""),
                            "vtt" | "srt"
                        )
                    }) {
                        if let Some(url) = track.get("url").and_then(|v| v.as_str()) {
                            subs.push(SubtitleTrack {
                                language: lang.clone(),
                                name: format!(
                                    "{lang}（{}）",
                                    if source == "subtitles" {
                                        "官方"
                                    } else {
                                        "自动"
                                    }
                                ),
                                url: url.to_string(),
                            });
                        }
                    }
                }
            }
        }
        if !subs.is_empty() {
            break;
        }
    }

    let notes = if video_url.is_none() {
        Some(
            "未能拿到合并 mp4 直链；YouTube 高清通常是 DASH 分离流，需 yt-dlp 直接下载并本地合流"
                .to_string(),
        )
    } else {
        None
    };

    Ok(YoutubeVideoInfo {
        title,
        uploader,
        cover,
        duration,
        video_url,
        subtitle_urls: subs,
        notes,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::{extract_video, parse_video_json, YoutubeRuntime};

    #[tokio::test]
    async fn shared_runtime_extracts_youtube_without_a_system_yt_dlp() {
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("runtime-bridge");
        let quickjs = directory.path().join("qjs");
        std::fs::write(&quickjs, b"runtime").unwrap();
        std::fs::write(
            &program,
            r#"#!/bin/sh
[ "$1" = "--youtube" ] || exit 41
[ "$2" = "https://youtu.be/example" ] || exit 42
[ "$3" = "--js-runtime" ] || exit 43
[ -f "$4" ] || exit 44
[ "$5" = "--proxy" ] || exit 45
[ "$6" = "http://127.0.0.1:7890" ] || exit 46
printf '%s' '{"title":"Embedded runtime","uploader":"AT","thumbnail":"https://example/cover.jpg","duration":12,"url":"https://example/video.mp4","subtitles":{}}'
"#,
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&program).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&program, permissions).unwrap();

        let result = extract_video(
            &YoutubeRuntime::new(program, quickjs),
            "https://youtu.be/example",
            Some("http://127.0.0.1:7890"),
        )
        .await
        .unwrap();

        assert_eq!(result.title, "Embedded runtime");
        assert_eq!(
            result.video_url.as_deref(),
            Some("https://example/video.mp4")
        );
    }

    #[test]
    fn parser_prefers_manual_supported_subtitles_and_combined_mp4() {
        let result = parse_video_json(br#"{
          "title":"Fixture",
          "url":"https://example.com/combined.mp4",
          "subtitles":{
            "en":[{"ext":"json3","url":"https://example.com/en.json"},{"ext":"vtt","url":"https://example.com/en.vtt"}],
            "fr":[{"ext":"vtt","url":"https://example.com/fr.vtt"}]
          },
          "automatic_captions":{"zh":[{"ext":"vtt","url":"https://example.com/zh.vtt"}]}
        }"#).unwrap();

        assert_eq!(
            result.video_url.as_deref(),
            Some("https://example.com/combined.mp4")
        );
        assert_eq!(result.subtitle_urls.len(), 1);
        assert_eq!(result.subtitle_urls[0].language, "en");
        assert_eq!(result.subtitle_urls[0].url, "https://example.com/en.vtt");
    }
}
