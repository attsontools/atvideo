use serde::Serialize;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideoInfo {
    pub title: String,
    pub cover: Option<String>,
    pub uploader: Option<String>,
    pub bvid: String,
    pub duration: Option<i64>,
    pub video_url: Option<String>,
    pub audio_url: Option<String>,
    pub quality_note: Option<String>,
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("构造 HTTP 客户端失败：{error}"))
}

pub async fn resolve_short_url(url: &str) -> Result<String, String> {
    let client = build_client()?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;
    Ok(response.url().to_string())
}

pub fn extract_bvid(url: &str) -> Option<String> {
    // Pattern: /video/BVxxxxxxxxxx  (BV + 10 chars alphanumeric)
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"/(BV[0-9A-Za-z]{10})").unwrap());
    re.captures(url)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

struct ViewData {
    title: String,
    cover: Option<String>,
    uploader: Option<String>,
    duration: Option<i64>,
    cid: Option<i64>,
}

fn parse_view_data(view_json: &serde_json::Value) -> Result<ViewData, String> {
    let code = view_json
        .get("code")
        .and_then(|value| value.as_i64())
        .unwrap_or(-1);
    if code != 0 {
        let message = view_json
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("未知错误");
        return Err(format!(
            "B 站 view API 返回：{message}（可能笔记不存在或需登录）"
        ));
    }

    let data = view_json
        .get("data")
        .ok_or_else(|| "view API 无 data 字段".to_string())?;
    Ok(ViewData {
        title: data
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string(),
        cover: data
            .get("pic")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        uploader: data
            .get("owner")
            .and_then(|owner| owner.get("name"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        duration: data.get("duration").and_then(|value| value.as_i64()),
        cid: data.get("cid").and_then(|value| value.as_i64()),
    })
}

#[derive(Default)]
struct PlayMedia {
    video_url: Option<String>,
    audio_url: Option<String>,
    quality_note: Option<String>,
}

fn parse_play_url(json: &serde_json::Value) -> PlayMedia {
    if json.get("code").and_then(|value| value.as_i64()) != Some(0) {
        return PlayMedia::default();
    }

    let data = json.get("data");
    if let Some(dash) = data.and_then(|value| value.get("dash")) {
        return PlayMedia {
            video_url: dash
                .get("video")
                .and_then(|items| items.get(0))
                .and_then(|entry| entry.get("baseUrl").or_else(|| entry.get("base_url")))
                .and_then(|value| value.as_str())
                .map(str::to_string),
            audio_url: dash
                .get("audio")
                .and_then(|items| items.get(0))
                .and_then(|entry| entry.get("baseUrl").or_else(|| entry.get("base_url")))
                .and_then(|value| value.as_str())
                .map(str::to_string),
            quality_note: Some(
                "DASH 分离流：视频与音频分开下载，需自行合流（ffmpeg -c copy）".to_string(),
            ),
        };
    }

    let video_url = data
        .and_then(|value| value.get("durl"))
        .and_then(|items| items.as_array())
        .and_then(|items| items.first())
        .and_then(|entry| entry.get("url"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    PlayMedia {
        quality_note: video_url
            .as_ref()
            .map(|_| "FLV 单流（无需合流）".to_string()),
        video_url,
        audio_url: None,
    }
}

pub async fn extract_video(url: &str) -> Result<BiliVideoInfo, String> {
    let resolved = resolve_short_url(url).await?;
    let bvid = extract_bvid(&resolved).ok_or_else(|| "未能从 URL 提取 BVID".to_string())?;

    let client = build_client()?;
    let view_url = format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}");
    let view_json: serde_json::Value = client
        .get(&view_url)
        .header("Referer", "https://www.bilibili.com/")
        .send()
        .await
        .map_err(|error| format!("请求 view API 失败：{error}"))?
        .json()
        .await
        .map_err(|error| format!("解析 view JSON 失败：{error}"))?;
    let view = parse_view_data(&view_json)?;

    let mut media = PlayMedia::default();
    if let Some(cid) = view.cid {
        let playurl = format!(
            "https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=64&fnval=16&fnver=0&fourk=0"
        );
        if let Ok(resp) = client
            .get(&playurl)
            .header("Referer", "https://www.bilibili.com/")
            .send()
            .await
        {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                media = parse_play_url(&json);
            }
        }
    }

    if media.video_url.is_none() {
        media.quality_note = Some(
            "未能获取播放地址，可能需要登录或视频受限。可用 复制页面 + 浏览器打开".to_string(),
        );
    }

    Ok(BiliVideoInfo {
        title: view.title,
        cover: view.cover,
        uploader: view.uploader,
        bvid,
        duration: view.duration,
        video_url: media.video_url,
        audio_url: media.audio_url,
        quality_note: media.quality_note,
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_play_url, parse_view_data};

    #[test]
    fn parses_view_fixture_with_numeric_duration() {
        let fixture = serde_json::json!({
            "code": 0,
            "data": {
                "title": "示例视频",
                "pic": "https://img.example/cover.jpg",
                "owner": { "name": "示例作者" },
                "duration": 127,
                "cid": 456
            }
        });

        let view = parse_view_data(&fixture).unwrap();

        assert_eq!(view.title, "示例视频");
        assert_eq!(view.cover.as_deref(), Some("https://img.example/cover.jpg"));
        assert_eq!(view.uploader.as_deref(), Some("示例作者"));
        assert_eq!(view.duration, Some(127));
        assert_eq!(view.cid, Some(456));
    }

    #[test]
    fn parses_dash_play_url_fixture() {
        let fixture = serde_json::json!({
            "code": 0,
            "data": {
                "dash": {
                    "video": [{ "baseUrl": "https://video.example/stream.m4s" }],
                    "audio": [{ "base_url": "https://audio.example/stream.m4s" }]
                }
            }
        });

        let media = parse_play_url(&fixture);

        assert_eq!(
            media.video_url.as_deref(),
            Some("https://video.example/stream.m4s")
        );
        assert_eq!(
            media.audio_url.as_deref(),
            Some("https://audio.example/stream.m4s")
        );
        assert!(media.quality_note.unwrap().contains("DASH"));
    }
}
