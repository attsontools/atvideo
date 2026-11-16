use atvideo_service::{negotiate, HandshakeRequest, APP_ID};

#[test]
fn compatible_client_negotiates_video_extract_capability() {
    let request = HandshakeRequest {
        protocol_version: 1,
        app_id: APP_ID.into(),
        client_id: "test-client".into(),
        request_id: "request-1".into(),
        host_api: "2.x".into(),
        data_api: "1.x".into(),
        service_api: "1.x".into(),
        data_directory: "/tmp/video-data".into(),
        token: "secret".into(),
    };

    let response = negotiate(&request, "secret", "/tmp/video-data").unwrap();

    assert_eq!(response.app_id, APP_ID);
    assert!(response.capabilities.video_extract);
    assert_eq!(response.migration_state, "ready");
    assert_eq!(response.lease_state, "owner");
}

#[test]
fn handshake_rejects_the_wrong_application_or_data_directory() {
    let mut request = HandshakeRequest {
        protocol_version: 1,
        app_id: "com.example.other".into(),
        client_id: "test-client".into(),
        request_id: "request-1".into(),
        host_api: "2.x".into(),
        data_api: "1.x".into(),
        service_api: "1.x".into(),
        data_directory: "/tmp/video-data".into(),
        token: "secret".into(),
    };

    assert_eq!(
        negotiate(&request, "secret", "/tmp/video-data")
            .unwrap_err()
            .code,
        "VIDEO_SERVICE_REQUEST_INVALID"
    );
    request.app_id = APP_ID.into();
    request.data_directory = "/tmp/other".into();
    assert_eq!(
        negotiate(&request, "secret", "/tmp/video-data")
            .unwrap_err()
            .code,
        "VIDEO_SERVICE_REQUEST_INVALID"
    );
}
