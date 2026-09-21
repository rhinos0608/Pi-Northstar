use northstar_broker::worker::{
    kill_to_zero, launch, terminate_graceful, EnvGrantError, ScopedEnv, WorkerSpec,
    DEFAULT_DENIED_PREFIXES, MAX_ENV_VALUE_BYTES,
};

fn true_cmd() -> String {
    if std::path::Path::new("/bin/true").exists() {
        "/bin/true".to_string()
    } else {
        "/usr/bin/true".to_string()
    }
}

fn sleep_cmd() -> String {
    if std::path::Path::new("/bin/sleep").exists() {
        "/bin/sleep".to_string()
    } else {
        "/usr/bin/sleep".to_string()
    }
}

#[test]
fn test_scoped_env_starts_empty() {
    let env = ScopedEnv::new();
    assert!(env.build_command_env().is_empty());
}

#[test]
fn test_scoped_env_explicit_grants() {
    let mut env = ScopedEnv::new();
    env.grant("FOO", "bar").unwrap();
    env.grant("BAZ_QUX_123", "val").unwrap();

    let map = env.build_command_env();
    assert_eq!(map.len(), 2);
    assert_eq!(map.get("FOO").unwrap(), "bar");
    assert_eq!(map.get("BAZ_QUX_123").unwrap(), "val");
}

#[test]
fn test_denied_prefixes_rejected() {
    for prefix in DEFAULT_DENIED_PREFIXES {
        let mut env = ScopedEnv::new();
        let key = format!("{}TOKEN", prefix);
        let err = env.grant(&key, "secret").unwrap_err();
        assert_eq!(err, EnvGrantError::DeniedPrefix(key));
    }

    let mut env = ScopedEnv::new();
    let err = env.grant("GITHUB_TOKEN", "ghp_12345").unwrap_err();
    assert_eq!(err, EnvGrantError::DeniedPrefix("GITHUB_TOKEN".to_string()));

    let err2 = env.grant("AWS_SECRET_ACCESS_KEY", "secret").unwrap_err();
    assert_eq!(
        err2,
        EnvGrantError::DeniedPrefix("AWS_SECRET_ACCESS_KEY".to_string())
    );

    let err3 = env.grant("KUBECONFIG", "/etc/kube").unwrap_err();
    assert_eq!(err3, EnvGrantError::DeniedPrefix("KUBECONFIG".to_string()));
}

#[test]
fn test_override_allowlist_permits_denied_prefix() {
    let mut env = ScopedEnv::new();
    env.allow_override("GITHUB_");
    env.grant("GITHUB_TOKEN", "token_val").unwrap();

    assert_eq!(
        env.build_command_env().get("GITHUB_TOKEN").unwrap(),
        "token_val"
    );

    // Other denied prefix still fails
    let err = env.grant("AWS_ACCESS_KEY", "key").unwrap_err();
    assert_eq!(err, EnvGrantError::DeniedPrefix("AWS_ACCESS_KEY".to_string()));
}

#[test]
fn test_key_validation_rejects_invalid() {
    let mut env = ScopedEnv::new();

    // lowercase
    assert_eq!(
        env.grant("foo", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("foo".to_string())
    );
    assert_eq!(
        env.grant("Foo_Bar", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("Foo_Bar".to_string())
    );

    // empty
    assert_eq!(
        env.grant("", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("".to_string())
    );

    // starting with digit
    assert_eq!(
        env.grant("1FOO", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("1FOO".to_string())
    );

    // invalid characters (hyphen, dot, space)
    assert_eq!(
        env.grant("FOO-BAR", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("FOO-BAR".to_string())
    );
    assert_eq!(
        env.grant("FOO.BAR", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("FOO.BAR".to_string())
    );
    assert_eq!(
        env.grant("FOO BAR", "bar").unwrap_err(),
        EnvGrantError::InvalidKey("FOO BAR".to_string())
    );

    // Leading underscore is allowed
    assert!(env.grant("_VALID_KEY", "123").is_ok());
    assert!(env.grant("VALID_KEY_2", "456").is_ok());
}

#[test]
fn test_value_size_limit() {
    let mut env = ScopedEnv::new();
    let exact_4096 = "a".repeat(MAX_ENV_VALUE_BYTES);
    assert!(env.grant("VALID_VAL", &exact_4096).is_ok());

    let too_large = "a".repeat(MAX_ENV_VALUE_BYTES + 1);
    assert_eq!(
        env.grant("TOO_LARGE", &too_large).unwrap_err(),
        EnvGrantError::ValueTooLarge(MAX_ENV_VALUE_BYTES + 1)
    );
}

#[test]
fn test_ambient_secret_leak_probe_in_map() {
    std::env::set_var("NS_TEST_SECRET_LEAK_PROBE", "super_secret_ambient_token");

    let mut env = ScopedEnv::new();
    env.grant("EXPLICIT_VAR", "visible").unwrap();

    {
        let map = env.build_command_env();
        assert!(!map.contains_key("NS_TEST_SECRET_LEAK_PROBE"));
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("EXPLICIT_VAR").unwrap(), "visible");
    }

    // Leave no ambient env changes behind.
    std::env::remove_var("NS_TEST_SECRET_LEAK_PROBE");
    assert!(std::env::var_os("NS_TEST_SECRET_LEAK_PROBE").is_none());
}

#[cfg(unix)]
#[test]
fn test_live_spawn_true_unix() {
    // No ambient env mutation: launch uses env_clear + explicit grants only,
    // so the child cannot inherit ambient secrets regardless of test env.
    let mut env = ScopedEnv::new();
    env.grant("PERMITTED_VAR", "test_val").unwrap();

    let spec = WorkerSpec {
        program: true_cmd(),
        args: vec![],
        scoped_env: env,
        timeout_ms: 5000,
        run_as_uid: None,
        run_as_gid: None,
    };

    let mut child = launch(&spec).expect("launch true must succeed");
    let status = child.wait().expect("child must exit successfully");
    assert!(status.success());
}

#[cfg(unix)]
#[test]
fn test_graceful_terminate_fast_exit() {
    let spec = WorkerSpec {
        program: true_cmd(),
        args: vec![],
        scoped_env: ScopedEnv::new(),
        timeout_ms: 5000,
        run_as_uid: None,
        run_as_gid: None,
    };

    let mut child = launch(&spec).expect("launch true");
    // Wait slightly so /bin/true has finished
    std::thread::sleep(std::time::Duration::from_millis(50));
    let needed_sigkill = terminate_graceful(&mut child, 1000).expect("terminate_graceful");
    assert!(!needed_sigkill, "fast-exiting true must not require SIGKILL");
}

#[cfg(unix)]
#[test]
fn test_graceful_terminate_timeout_escalates_to_sigkill() {
    // When a process ignores SIGTERM, graceful termination waits grace_ms and escalates to SIGKILL.
    // We launch a process ignoring SIGTERM. Fixed argv, no shell: invoke sh with argv to trap TERM.
    let sh_path = if std::path::Path::new("/bin/sh").exists() {
        "/bin/sh"
    } else {
        "/usr/bin/sh"
    };

    let spec = WorkerSpec {
        program: sh_path.to_string(),
        args: vec!["-c".to_string(), "trap '' TERM; sleep 60".to_string()],
        scoped_env: ScopedEnv::new(),
        timeout_ms: 5000,
        run_as_uid: None,
        run_as_gid: None,
    };

    let mut child = launch(&spec).expect("launch process ignoring SIGTERM");
    // Allow sh to enter trap and sleep
    std::thread::sleep(std::time::Duration::from_millis(50));
    let needed_sigkill = terminate_graceful(&mut child, 50).expect("terminate_graceful");
    assert!(
        needed_sigkill,
        "process ignoring SIGTERM must require SIGKILL after 50ms grace window"
    );
}

#[cfg(unix)]
#[test]
fn test_kill_to_zero_reaps_process() {
    let spec = WorkerSpec {
        program: sleep_cmd(),
        args: vec!["60".to_string()],
        scoped_env: ScopedEnv::new(),
        timeout_ms: 5000,
        run_as_uid: None,
        run_as_gid: None,
    };

    let mut child = launch(&spec).expect("launch sleep 60");
    let reaped = kill_to_zero(&mut child).expect("kill_to_zero");
    assert!(reaped);
}

#[cfg(target_os = "windows")]
#[test]
fn test_windows_launch_returns_unsupported() {
    let spec = WorkerSpec {
        program: "cmd.exe".to_string(),
        args: vec![],
        scoped_env: ScopedEnv::new(),
        timeout_ms: 5000,
        run_as_uid: None,
        run_as_gid: None,
    };

    let result = launch(&spec);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::Unsupported);
    assert!(err.to_string().contains("Tier 2 Job Object"));
}
