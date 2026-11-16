use atvideo_service::VideoService;
use serde_json::json;

#[tokio::test]
async fn service_rejects_unknown_methods() {
    let service = VideoService::default();

    let error = service
        .request("video.unknown", json!({}))
        .await
        .unwrap_err();

    assert_eq!(error.code, "VIDEO_SERVICE_METHOD_NOT_FOUND");
}

#[tokio::test]
async fn all_video_methods_reject_extra_parameters_before_dispatch() {
    let service = VideoService::default();

    for method in [
        "video.douyin.resolve",
        "video.douyin.extract",
        "video.xhs.extract",
        "video.bilibili.extract",
        "video.youtube.extract",
    ] {
        let error = service
            .request(
                method,
                json!({
                    "url": "https://example.com/video",
                    "unexpected": true
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "VIDEO_SERVICE_INVALID_PARAMS", "{method}");
    }
}
