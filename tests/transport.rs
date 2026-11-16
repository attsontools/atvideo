use std::fs;

use atvideo_service::{
    read_endpoint, HandshakeRequest, ServiceHandshake, ServiceReply, ServiceRequest, ServiceServer,
    APP_ID,
};
use serde_json::json;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

#[tokio::test]
async fn tcp_transport_handshakes_and_returns_video_domain_errors() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("video");
    fs::create_dir_all(&data).unwrap();
    let endpoint_path = data.join("service.endpoint.json");
    let server = ServiceServer::bind(endpoint_path.clone(), data.clone(), "0.1.0-alpha.0")
        .await
        .unwrap();
    let stop = server.stop_handle();
    let task = tokio::spawn(server.run());
    let endpoint = read_endpoint(&endpoint_path).unwrap();
    let stream = TcpStream::connect(("127.0.0.1", endpoint.port))
        .await
        .unwrap();
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    write_line(
        &mut writer,
        &ServiceHandshake::Request(HandshakeRequest {
            protocol_version: 1,
            app_id: APP_ID.into(),
            client_id: "transport-test".into(),
            request_id: "handshake-1".into(),
            host_api: "2.x".into(),
            data_api: "1.x".into(),
            service_api: "1.x".into(),
            data_directory: data.to_string_lossy().into_owned(),
            token: endpoint.token,
        }),
    )
    .await;
    let reply: ServiceReply = read_line(&mut reader).await;
    assert!(matches!(reply, ServiceReply::Handshake(_)));

    write_line(
        &mut writer,
        &ServiceRequest::Request {
            request_id: "request-1".into(),
            method: "video.youtube.extract".into(),
            params: json!({}),
        },
    )
    .await;
    let reply: ServiceReply = read_line(&mut reader).await;
    match reply {
        ServiceReply::Error { request_id, error } => {
            assert_eq!(request_id, "request-1");
            assert_eq!(error.code, "VIDEO_SERVICE_INVALID_PARAMS");
        }
        other => panic!("expected video domain error, got {other:?}"),
    }

    stop.notify_one();
    task.await.unwrap().unwrap();
    assert!(!endpoint_path.exists());
}

async fn write_line(writer: &mut tokio::net::tcp::OwnedWriteHalf, value: &impl serde::Serialize) {
    let mut bytes = serde_json::to_vec(value).unwrap();
    bytes.push(b'\n');
    writer.write_all(&bytes).await.unwrap();
}

async fn read_line<T: serde::de::DeserializeOwned>(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> T {
    let mut bytes = Vec::new();
    reader.read_until(b'\n', &mut bytes).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
