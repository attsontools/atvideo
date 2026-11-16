use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::{bilibili, douyin, xhs, youtube, ServiceError};

#[derive(Clone)]
pub struct VideoService {
    youtube_runtime: youtube::YoutubeRuntime,
}

impl Default for VideoService {
    fn default() -> Self {
        Self {
            youtube_runtime: youtube::YoutubeRuntime::discover(),
        }
    }
}

impl VideoService {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ServiceError> {
        match method {
            "video.douyin.resolve" => {
                let params: UrlParams = decode_params(params)?;
                validate_url(&params.url, &["v.douyin.com"])?;
                douyin::resolve_url(&params.url)
                    .await
                    .map(Value::String)
                    .map_err(classify_platform_error)
            }
            "video.douyin.extract" => {
                let params: UrlParams = decode_params(params)?;
                validate_url(&params.url, &["www.douyin.com", "www.iesdouyin.com"])?;
                serialize_result(
                    douyin::extract_video(&params.url)
                        .await
                        .map_err(classify_platform_error)?,
                )
            }
            "video.xhs.extract" => {
                let params: UrlParams = decode_params(params)?;
                validate_url(&params.url, &["xhslink.com", "www.xiaohongshu.com"])?;
                serialize_result(
                    xhs::extract_note(&params.url)
                        .await
                        .map_err(classify_platform_error)?,
                )
            }
            "video.bilibili.extract" => {
                let params: UrlParams = decode_params(params)?;
                validate_url(
                    &params.url,
                    &["www.bilibili.com", "m.bilibili.com", "b23.tv"],
                )?;
                serialize_result(
                    bilibili::extract_video(&params.url)
                        .await
                        .map_err(classify_platform_error)?,
                )
            }
            "video.youtube.extract" => {
                let params: YoutubeParams = decode_params(params)?;
                validate_url(
                    &params.url,
                    &[
                        "www.youtube.com",
                        "youtube.com",
                        "m.youtube.com",
                        "youtu.be",
                    ],
                )?;
                if let Some(proxy) = params.proxy.as_deref() {
                    validate_proxy(proxy)?;
                }
                serialize_result(
                    youtube::extract_video(
                        &self.youtube_runtime,
                        &params.url,
                        params.proxy.as_deref(),
                    )
                    .await?,
                )
            }
            _ => Err(ServiceError::new(
                "VIDEO_SERVICE_METHOD_NOT_FOUND",
                "video service method is not available",
            )),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UrlParams {
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YoutubeParams {
    url: String,
    proxy: Option<String>,
}

fn decode_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, ServiceError> {
    serde_json::from_value(params).map_err(|_| invalid_params())
}

fn validate_url(raw: &str, hosts: &[&str]) -> Result<(), ServiceError> {
    if raw.len() > 8192 {
        return Err(invalid_params());
    }
    let url = Url::parse(raw).map_err(|_| invalid_params())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !hosts.contains(&url.host_str().unwrap_or_default())
    {
        return Err(invalid_params());
    }
    Ok(())
}

fn validate_proxy(raw: &str) -> Result<(), ServiceError> {
    if raw.as_bytes().len() > 2048 {
        return Err(invalid_params());
    }
    let proxy = Url::parse(raw).map_err(|_| invalid_params())?;
    if !matches!(proxy.scheme(), "http" | "https" | "socks5")
        || !proxy.username().is_empty()
        || proxy.password().is_some()
        || proxy.host_str().is_none()
    {
        return Err(invalid_params());
    }
    Ok(())
}

fn serialize_result(value: impl serde::Serialize) -> Result<Value, ServiceError> {
    serde_json::to_value(value).map_err(|_| {
        ServiceError::new(
            "VIDEO_SERVICE_INTERNAL",
            "video service could not encode the response",
        )
    })
}

fn classify_platform_error(message: String) -> ServiceError {
    let code = if message.contains("HTTP ") || message.contains("API 返回") {
        "VIDEO_SERVICE_HTTP_FAILED"
    } else if message.contains("请求")
        || message.contains("网络")
        || message.contains("读取")
        || message.contains("HTTP 客户端")
    {
        "VIDEO_SERVICE_NETWORK_FAILED"
    } else {
        "VIDEO_SERVICE_PAGE_STRUCTURE_CHANGED"
    };
    ServiceError::new(code, message)
}

fn invalid_params() -> ServiceError {
    ServiceError::new(
        "VIDEO_SERVICE_INVALID_PARAMS",
        "video service parameters are invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::{validate_proxy, validate_url};

    #[test]
    fn url_validation_rejects_credentials_and_unapproved_hosts() {
        assert!(validate_url("https://www.youtube.com/watch?v=ok", &["www.youtube.com"]).is_ok());
        assert!(validate_url(
            "https://user:secret@www.youtube.com/watch?v=no",
            &["www.youtube.com"]
        )
        .is_err());
        assert!(validate_url("https://example.com/watch", &["www.youtube.com"]).is_err());
    }

    #[test]
    fn proxy_validation_allows_only_credential_free_approved_schemes() {
        assert!(validate_proxy("socks5://127.0.0.1:1080").is_ok());
        assert!(validate_proxy("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy("ftp://127.0.0.1").is_err());
        assert!(validate_proxy("http://user:secret@127.0.0.1").is_err());
    }
}
