use std::{
    io,
    net::TcpListener as StdTcpListener,
    sync::{
        atomic::{AtomicI32, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use atvideo_service::{
    write_endpoint, Endpoint, ServiceLaunchSpec, ServiceLauncher, ServiceProcess, ServiceServer,
    ServiceSupervisor, ServiceSupervisorError,
};
use serde_json::json;

const RUNNING: i32 = i32::MIN;

#[derive(Default)]
struct ServerLauncher {
    launches: AtomicUsize,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
}

impl ServerLauncher {
    fn launch_count(&self) -> usize {
        self.launches.load(Ordering::SeqCst)
    }

    fn abort_all(&self) {
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl ServiceLauncher for ServerLauncher {
    fn launch(
        &self,
        spec: &ServiceLaunchSpec,
    ) -> Result<Box<dyn ServiceProcess>, ServiceSupervisorError> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        let exit_code = Arc::new(AtomicI32::new(RUNNING));
        let task_exit_code = Arc::clone(&exit_code);
        let endpoint_path = spec.endpoint_path.clone();
        let data_directory = spec.data_directory.clone();
        let service_version = spec.service_version.clone();
        let task = tokio::spawn(async move {
            let result =
                match ServiceServer::bind(endpoint_path, data_directory, service_version).await {
                    Ok(server) => server.run().await,
                    Err(error) => Err(error),
                };
            task_exit_code.store(if result.is_ok() { 0 } else { 1 }, Ordering::SeqCst);
        });
        self.tasks.lock().unwrap().push(task.abort_handle());
        Ok(Box::new(TestProcess { exit_code }))
    }
}

struct TestProcess {
    exit_code: Arc<AtomicI32>,
}

impl ServiceProcess for TestProcess {
    fn try_exit(&mut self) -> io::Result<Option<i32>> {
        let code = self.exit_code.load(Ordering::SeqCst);
        Ok((code != RUNNING).then_some(code))
    }
}

struct ExitedLauncher;

impl ServiceLauncher for ExitedLauncher {
    fn launch(
        &self,
        _spec: &ServiceLaunchSpec,
    ) -> Result<Box<dyn ServiceProcess>, ServiceSupervisorError> {
        Ok(Box::new(TestProcess {
            exit_code: Arc::new(AtomicI32::new(17)),
        }))
    }
}

#[tokio::test]
async fn concurrent_supervisors_share_the_single_service_that_wins_the_lease() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    let endpoint = data.join("service.endpoint.json");
    let launcher = Arc::new(ServerLauncher::default());
    let mut first = supervisor(&endpoint, &data, launcher.clone());
    let mut second = supervisor(&endpoint, &data, launcher.clone());

    let (first_client, second_client) = tokio::join!(first.connect(), second.connect());
    let first_client = first_client.unwrap();
    let second_client = second_client.unwrap();

    assert_eq!(launcher.launch_count(), 2);
    assert_eq!(
        first_client
            .request("video.youtube.extract", json!({}))
            .await
            .unwrap_err()
            .code,
        "VIDEO_SERVICE_INVALID_PARAMS"
    );
    assert_eq!(
        second_client
            .request("video.youtube.extract", json!({}))
            .await
            .unwrap_err()
            .code,
        "VIDEO_SERVICE_INVALID_PARAMS"
    );
    launcher.abort_all();
}

#[tokio::test]
async fn stale_endpoint_and_matching_lease_are_replaced_before_launch() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let endpoint = data.join("service.endpoint.json");
    let listener = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
    let stale_port = listener.local_addr().unwrap().port();
    drop(listener);
    write_endpoint(
        &endpoint,
        &Endpoint {
            port: stale_port,
            token: "stale-token".into(),
            service_version: env!("CARGO_PKG_VERSION").into(),
        },
    )
    .unwrap();
    std::fs::write(data.join("service.lock"), "stale-token\n123\n").unwrap();
    let launcher = Arc::new(ServerLauncher::default());
    let mut supervisor = supervisor(&endpoint, &data, launcher.clone());

    let client = supervisor.connect().await.unwrap();

    assert_eq!(launcher.launch_count(), 1);
    assert_eq!(
        client
            .request("video.youtube.extract", json!({}))
            .await
            .unwrap_err()
            .code,
        "VIDEO_SERVICE_INVALID_PARAMS"
    );
    launcher.abort_all();
}

#[tokio::test]
async fn child_exit_without_a_competing_lease_fails_before_the_timeout() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    let endpoint = data.join("service.endpoint.json");
    let mut supervisor = supervisor(&endpoint, &data, Arc::new(ExitedLauncher));

    let error = match supervisor.connect().await {
        Ok(_) => panic!("exited service unexpectedly connected"),
        Err(error) => error,
    };

    assert_eq!(error.code, "VIDEO_SERVICE_START_FAILED");
    assert!(error.message.contains("status 17"));
}

fn supervisor(
    endpoint: &std::path::Path,
    data: &std::path::Path,
    launcher: Arc<dyn ServiceLauncher>,
) -> ServiceSupervisor {
    ServiceSupervisor::with_launcher(
        endpoint.to_path_buf(),
        data.to_path_buf(),
        "supervisor-test",
        env!("CARGO_PKG_VERSION"),
        Duration::from_secs(2),
        launcher,
    )
}
