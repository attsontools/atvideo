use std::{path::PathBuf, time::Duration};

use atvideo_service::{ServiceSupervisor, ServiceSupervisorError, StandaloneService};
use serde_json::Value;
use tauri::{Manager, State};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
async fn connect_video_service(
    service: State<'_, StandaloneService>,
) -> Result<(), ServiceSupervisorError> {
    service.connect().await
}

#[tauri::command]
async fn video_service_request(
    service: State<'_, StandaloneService>,
    method: String,
    params: Value,
) -> Result<Value, ServiceSupervisorError> {
    service.request(method, params).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_directory = shared_data_directory(app)?;
            let endpoint_path = data_directory.join("service.endpoint.json");
            let executable = service_executable(app)?;
            let supervisor = ServiceSupervisor::new(
                endpoint_path,
                data_directory,
                executable,
                "atvideo-standalone",
                env!("CARGO_PKG_VERSION"),
                STARTUP_TIMEOUT,
            );
            app.manage(StandaloneService::new(supervisor));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_video_service,
            video_service_request,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AT Video");
}

fn shared_data_directory(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("ATVIDEO_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    let standalone_directory = app.path().app_data_dir()?;
    let application_data_root = standalone_directory
        .parent()
        .ok_or_else(|| std::io::Error::other("standalone app data directory has no parent"))?;
    Ok(application_data_root
        .join("com.attson.attool")
        .join("native-services")
        .join("com.attson.video"))
}

fn service_executable(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("ATVIDEO_SERVICE_EXECUTABLE") {
        return Ok(PathBuf::from(path));
    }
    let executable_name = if cfg!(windows) {
        "atvideo-service.exe"
    } else {
        "atvideo-service"
    };
    Ok(app.path().resource_dir()?.join(executable_name))
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    let (program, args) = external_url_command(std::env::consts::OS, &url)?;
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开链接失败：{error}"))
}

fn external_url_command(target_os: &str, raw_url: &str) -> Result<(String, Vec<String>), String> {
    let url = url::Url::parse(raw_url).map_err(|_| "链接格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅支持不含凭证的 http/https 链接".to_string());
    }
    let url = url.to_string();
    match target_os {
        "macos" => Ok(("open".to_string(), vec![url])),
        "windows" => Ok((
            "rundll32.exe".to_string(),
            vec!["url.dll,FileProtocolHandler".to_string(), url],
        )),
        "linux" => Ok(("xdg-open".to_string(), vec![url])),
        _ => Err("当前系统不支持打开外部链接".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::external_url_command;

    #[test]
    fn external_opener_accepts_only_credential_free_http_urls() {
        assert_eq!(
            external_url_command("linux", "https://example.com/watch").unwrap(),
            (
                "xdg-open".to_string(),
                vec!["https://example.com/watch".to_string()]
            )
        );
        assert!(external_url_command("linux", "file:///etc/passwd").is_err());
        assert!(external_url_command("linux", "https://user:secret@example.com").is_err());
    }
}
