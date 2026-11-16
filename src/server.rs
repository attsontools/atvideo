use std::{
    fs::{self, File, OpenOptions},
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};

use fs2::FileExt;
use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{tcp::OwnedWriteHalf, TcpListener, TcpStream},
    sync::{Mutex, Notify},
};
use uuid::Uuid;

use crate::{
    negotiate, write_endpoint, Endpoint, ErrorEnvelope, ServiceError, ServiceHandshake,
    ServiceReply, ServiceRequest, VideoService,
};

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

pub struct ServiceServer {
    listener: TcpListener,
    endpoint_path: PathBuf,
    data_directory: PathBuf,
    token: String,
    service: Arc<dyn RequestHandler>,
    stop: Arc<Notify>,
    _lease: ServiceLease,
}

impl ServiceServer {
    pub async fn bind(
        endpoint_path: PathBuf,
        data_directory: PathBuf,
        service_version: impl Into<String>,
    ) -> Result<Self, ServiceError> {
        Self::bind_with_handler_inner(
            endpoint_path,
            data_directory,
            service_version.into(),
            Arc::new(VideoService::default()),
        )
        .await
    }

    #[cfg(test)]
    async fn bind_with_handler(
        endpoint_path: PathBuf,
        data_directory: PathBuf,
        service_version: impl Into<String>,
        service: Arc<dyn RequestHandler>,
    ) -> Result<Self, ServiceError> {
        Self::bind_with_handler_inner(
            endpoint_path,
            data_directory,
            service_version.into(),
            service,
        )
        .await
    }

    async fn bind_with_handler_inner(
        endpoint_path: PathBuf,
        data_directory: PathBuf,
        service_version: String,
        service: Arc<dyn RequestHandler>,
    ) -> Result<Self, ServiceError> {
        fs::create_dir_all(&data_directory).map_err(|_| lease_error())?;
        let token = Uuid::new_v4().to_string();
        let lease = ServiceLease::acquire(&data_directory, &token)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| start_error())?;
        let port = listener.local_addr().map_err(|_| start_error())?.port();
        write_endpoint(
            &endpoint_path,
            &Endpoint {
                port,
                token: token.clone(),
                service_version,
            },
        )?;
        Ok(Self {
            listener,
            endpoint_path,
            data_directory,
            token,
            service,
            stop: Arc::new(Notify::new()),
            _lease: lease,
        })
    }

    pub fn stop_handle(&self) -> Arc<Notify> {
        Arc::clone(&self.stop)
    }

    pub async fn run(self) -> Result<(), ServiceError> {
        loop {
            tokio::select! {
                _ = self.stop.notified() => break,
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted.map_err(|_| ServiceError::new(
                        "VIDEO_SERVICE_ACCEPT_FAILED",
                        "cannot accept service connection",
                    ))?;
                    let service = self.service.clone();
                    let token = self.token.clone();
                    let data_directory = self.data_directory.to_string_lossy().into_owned();
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, service, token, data_directory).await;
                    });
                }
            }
        }
        let _ = fs::remove_file(&self.endpoint_path);
        Ok(())
    }
}

async fn handle_connection(
    stream: TcpStream,
    service: Arc<dyn RequestHandler>,
    token: String,
    data_directory: String,
) -> Result<(), ServiceError> {
    let (reader, writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let writer = Arc::new(Mutex::new(writer));
    let mut line = Vec::new();
    read_line(&mut reader, &mut line).await?;
    let handshake = serde_json::from_slice::<ServiceHandshake>(&line).map_err(|_| {
        ServiceError::new(
            "VIDEO_SERVICE_REQUEST_INVALID",
            "cannot decode service handshake",
        )
    })?;
    let request = match handshake {
        ServiceHandshake::Request(request) => request,
        ServiceHandshake::Response(_) => {
            return Err(ServiceError::new(
                "VIDEO_SERVICE_REQUEST_INVALID",
                "expected handshake request",
            ));
        }
    };
    let response = match negotiate(&request, &token, &data_directory) {
        Ok(response) => ServiceReply::Handshake(response),
        Err(error) => {
            write_reply(
                &writer,
                &ServiceReply::Error {
                    request_id: request.request_id,
                    error: error.into(),
                },
            )
            .await?;
            return Ok(());
        }
    };
    write_reply(&writer, &response).await?;

    loop {
        line.clear();
        match read_line(&mut reader, &mut line).await {
            Ok(false) => break,
            Ok(true) => {}
            Err(error) => return Err(error),
        }
        let request = match serde_json::from_slice::<ServiceRequest>(&line) {
            Ok(request) => request,
            Err(_) => {
                write_reply(
                    &writer,
                    &ServiceReply::Error {
                        request_id: String::new(),
                        error: ErrorEnvelope {
                            code: "VIDEO_SERVICE_REQUEST_INVALID".into(),
                            message: "cannot decode service request".into(),
                            retryable: false,
                        },
                    },
                )
                .await?;
                continue;
            }
        };
        let ServiceRequest::Request {
            request_id,
            method,
            params,
        } = request;
        let service = Arc::clone(&service);
        let writer = Arc::clone(&writer);
        tokio::spawn(async move {
            let reply = match service.request(&method, params).await {
                Ok(result) => ServiceReply::Response { request_id, result },
                Err(error) => ServiceReply::Error {
                    request_id,
                    error: error.into(),
                },
            };
            let _ = write_reply(&writer, &reply).await;
        });
    }
    Ok(())
}

trait RequestHandler: Send + Sync {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ServiceError>> + Send + 'a>>;
}

impl RequestHandler for VideoService {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ServiceError>> + Send + 'a>> {
        Box::pin(VideoService::request(self, method, params))
    }
}

async fn read_line<R>(reader: &mut R, line: &mut Vec<u8>) -> Result<bool, ServiceError>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let available = reader.fill_buf().await.map_err(|_| disconnected())?;
        if available.is_empty() {
            return Ok(!line.is_empty());
        }
        let chunk_len = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| position + 1)
            .unwrap_or(available.len());
        let remaining = MAX_LINE_BYTES.saturating_add(1).saturating_sub(line.len());
        let consumed = chunk_len.min(remaining);
        line.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if line.len() > MAX_LINE_BYTES {
            return Err(ServiceError::new(
                "VIDEO_SERVICE_REQUEST_TOO_LARGE",
                "service message exceeds 8 MiB",
            ));
        }
        if consumed == chunk_len && line.last() == Some(&b'\n') {
            return Ok(true);
        }
    }
}

async fn write_reply(
    writer: &Arc<Mutex<OwnedWriteHalf>>,
    reply: &ServiceReply,
) -> Result<(), ServiceError> {
    let mut bytes = serde_json::to_vec(reply).map_err(|_| {
        ServiceError::new(
            "VIDEO_SERVICE_RESPONSE_INVALID",
            "cannot encode service response",
        )
    })?;
    bytes.push(b'\n');
    writer
        .lock()
        .await
        .write_all(&bytes)
        .await
        .map_err(|_| disconnected())
}

struct ServiceLease {
    path: PathBuf,
    token: String,
    file: File,
}

impl ServiceLease {
    fn acquire(data_directory: &Path, token: &str) -> Result<Self, ServiceError> {
        let path = data_directory.join("service.lock");
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|_| lease_error())?;
        file.try_lock_exclusive().map_err(|_| {
            ServiceError::new(
                "VIDEO_SERVICE_ALREADY_RUNNING",
                "video service is already running",
            )
        })?;
        file.set_len(0).map_err(|_| lease_error())?;
        writeln!(file, "{token}\n{}", std::process::id()).map_err(|_| lease_error())?;
        file.sync_all().map_err(|_| lease_error())?;
        Ok(Self {
            path,
            token: token.into(),
            file,
        })
    }
}

impl Drop for ServiceLease {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path)
            .ok()
            .and_then(|value| value.lines().next().map(ToOwned::to_owned))
            .as_deref()
            == Some(self.token.as_str())
        {
            let _ = fs::remove_file(&self.path);
        }
        let _ = self.file.unlock();
    }
}

fn start_error() -> ServiceError {
    ServiceError::new("VIDEO_SERVICE_START_FAILED", "cannot start video service")
}

fn lease_error() -> ServiceError {
    ServiceError::new(
        "VIDEO_SERVICE_LEASE_FAILED",
        "cannot acquire video service lease",
    )
}

fn disconnected() -> ServiceError {
    ServiceError::new(
        "VIDEO_SERVICE_DISCONNECTED",
        "video service connection was closed",
    )
}

#[cfg(test)]
mod tests {
    use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

    use serde_json::{json, Value};
    use tokio::io::{duplex, AsyncWriteExt, BufReader};
    use tokio::sync::Notify;

    use super::{read_line, RequestHandler, ServiceServer, MAX_LINE_BYTES};
    use crate::{ServiceClient, ServiceError};

    struct BlockingHandler {
        started: Notify,
        release: Notify,
    }

    impl RequestHandler for BlockingHandler {
        fn request<'a>(
            &'a self,
            method: &'a str,
            _params: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, ServiceError>> + Send + 'a>> {
            Box::pin(async move {
                if method == "slow" {
                    self.started.notify_one();
                    self.release.notified().await;
                }
                Ok(json!({ "method": method }))
            })
        }
    }

    #[tokio::test]
    async fn oversized_line_is_rejected_before_the_peer_closes() {
        let (mut writer, reader) = duplex(64 * 1024);
        let writer_task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'a'; MAX_LINE_BYTES + 1])
                .await
                .unwrap();
            std::future::pending::<()>().await;
        });
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();

        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_line(&mut reader, &mut line),
        )
        .await
        .expect("oversized input should not wait for EOF")
        .unwrap_err();

        assert_eq!(error.code, "VIDEO_SERVICE_REQUEST_TOO_LARGE");
        writer_task.abort();
    }

    #[tokio::test]
    async fn one_request_does_not_block_another_request_on_the_same_connection() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint_path = directory.path().join("service.endpoint.json");
        let handler = Arc::new(BlockingHandler {
            started: Notify::new(),
            release: Notify::new(),
        });
        let server = ServiceServer::bind_with_handler(
            endpoint_path.clone(),
            directory.path().to_path_buf(),
            "test",
            handler.clone(),
        )
        .await
        .unwrap();
        let stop = server.stop_handle();
        let server_task = tokio::spawn(server.run());
        let client = Arc::new(
            ServiceClient::connect(&endpoint_path, directory.path(), "concurrency-test")
                .await
                .unwrap(),
        );

        let slow_client = client.clone();
        let slow = tokio::spawn(async move { slow_client.request("slow", json!({})).await });
        handler.started.notified().await;

        let fast = tokio::time::timeout(Duration::from_secs(1), client.request("fast", json!({})))
            .await
            .expect("the fast request should not wait for the slow request")
            .unwrap();

        assert_eq!(fast, json!({ "method": "fast" }));
        handler.release.notify_one();
        slow.await.unwrap().unwrap();
        stop.notify_one();
        server_task.await.unwrap().unwrap();
    }
}
