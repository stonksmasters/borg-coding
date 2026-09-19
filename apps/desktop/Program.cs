using System.ComponentModel;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BorgCode.Desktop;

internal static class Program
{
    private const string ActivationEventName = "BORG-Code-Desktop-Activate";
    private const string ExitEventName = "BORG-Code-Desktop-Exit";

    [STAThread]
    private static void Main(string[] args)
    {
        if (HandleUtilityCommand(args)) return;

        using var activationSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationEventName);
        using var exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ExitEventName);
        using var singleInstance = new Mutex(true, "BORG-Code-Desktop", out var firstInstance);
        if (!firstInstance)
        {
            activationSignal.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new BorgApplicationContext(args.Contains("--background"), activationSignal, exitSignal));
    }

    private static bool HandleUtilityCommand(string[] args)
    {
        var command = args.FirstOrDefault();
        if (command is "--install-startup" or "--remove-startup" or "--startup-status")
        {
            if (command == "--install-startup") StartupRegistration.SetEnabled(true);
            if (command == "--remove-startup") StartupRegistration.SetEnabled(false);
            Console.WriteLine(StartupRegistration.IsEnabled ? "enabled" : "disabled");
            return true;
        }

        if (command == "--request-exit")
        {
            try
            {
                using var signal = EventWaitHandle.OpenExisting(ExitEventName);
                signal.Set();
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                Environment.ExitCode = 2;
            }
            return true;
        }

        if (command is "--credential-get" or "--credential-set" or "--credential-delete")
        {
            var target = args.Skip(1).FirstOrDefault()?.Trim();
            if (string.IsNullOrWhiteSpace(target))
            {
                Console.Error.WriteLine("Credential target is required.");
                Environment.ExitCode = 2;
                return true;
            }

            try
            {
                if (command == "--credential-get")
                {
                    var secret = WindowsCredentialStore.Read(target);
                    if (secret is null) Environment.ExitCode = 2;
                    else Console.Out.Write(secret);
                }
                else if (command == "--credential-set")
                {
                    var secret = Console.In.ReadToEnd();
                    if (secret.Length == 0) throw new InvalidOperationException("Credential cannot be empty.");
                    WindowsCredentialStore.Write(target, secret);
                }
                else
                {
                    if (!WindowsCredentialStore.Delete(target)) Environment.ExitCode = 2;
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                Environment.ExitCode = 1;
            }
            return true;
        }

        return false;
    }
}

internal sealed class BorgApplicationContext : ApplicationContext
{
    private readonly BorgHost host = new();
    private readonly BorgWindow window;
    private readonly NotifyIcon trayIcon;
    private readonly EventWaitHandle activationSignal;
    private readonly EventWaitHandle exitSignal;
    private readonly Thread activationThread;
    private readonly Thread exitThread;
    private int exitStarted;

    public BorgApplicationContext(bool background, EventWaitHandle activationSignal, EventWaitHandle exitSignal)
    {
        this.activationSignal = activationSignal;
        this.exitSignal = exitSignal;
        window = new BorgWindow(host);
        _ = window.Handle;

        try { DesktopShortcut.EnsureExists(); }
        catch (Exception error) { host.LogLifecycle($"Desktop shortcut check failed: {error.Message}"); }
        try
        {
            if (!StartupRegistration.IsEnabled) StartupRegistration.SetEnabled(true);
        }
        catch (Exception error) { host.LogLifecycle($"Startup registration check failed: {error.Message}"); }

        var startupItem = new ToolStripMenuItem("Start with Windows")
        {
            Checked = StartupRegistration.IsEnabled,
            CheckOnClick = true,
        };
        var updatingStartupItem = false;
        startupItem.CheckedChanged += (_, _) =>
        {
            if (updatingStartupItem) return;
            try { StartupRegistration.SetEnabled(startupItem.Checked); }
            catch (Exception error)
            {
                updatingStartupItem = true;
                startupItem.Checked = StartupRegistration.IsEnabled;
                updatingStartupItem = false;
                MessageBox.Show(error.Message, "Unable to update Windows startup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        var menu = new ContextMenuStrip();
        menu.Items.Add("Open BORG", null, (_, _) => ShowWindow());
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, async (_, _) => await ExitAsync("tray Exit"));

        trayIcon = new NotifyIcon
        {
            Text = "BORG Code",
            Icon = SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = menu,
        };
        trayIcon.DoubleClick += (_, _) => ShowWindow();
        window.FormClosing += (_, eventArgs) =>
        {
            if (Volatile.Read(ref exitStarted) != 0) return;
            eventArgs.Cancel = true;
            window.Hide();
            host.LogLifecycle("Window close requested; hiding to tray.");
            trayIcon.ShowBalloonTip(1500, "BORG Code", "BORG is still running in the system tray.", ToolTipIcon.Info);
        };

        activationThread = new Thread(WaitForActivation) { IsBackground = true, Name = "BORG activation listener" };
        exitThread = new Thread(WaitForExitRequest) { IsBackground = true, Name = "BORG exit listener" };
        activationThread.Start();
        exitThread.Start();

        host.LogLifecycle($"Desktop application context started. Background={background}.");
        if (!background) ShowWindow();
        _ = window.InitializeAsync();
    }

    private void WaitForActivation()
    {
        while (Volatile.Read(ref exitStarted) == 0)
        {
            activationSignal.WaitOne();
            if (Volatile.Read(ref exitStarted) != 0) return;
            try { window.BeginInvoke(ShowWindow); }
            catch (InvalidOperationException) { return; }
        }
    }

    private void WaitForExitRequest()
    {
        exitSignal.WaitOne();
        if (Volatile.Read(ref exitStarted) != 0) return;
        try { window.BeginInvoke(() => _ = ExitAsync("external exit signal")); }
        catch (InvalidOperationException) { }
    }

    private void ShowWindow()
    {
        if (Volatile.Read(ref exitStarted) != 0) return;
        window.Show();
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Activate();
    }

    private async Task ExitAsync(string reason)
    {
        if (Interlocked.Exchange(ref exitStarted, 1) != 0) return;
        host.LogLifecycle($"Application quit path entered from {reason}.");
        activationSignal.Set();
        exitSignal.Set();
        trayIcon.Visible = false;

        try { await host.DisposeAsync(); }
        catch (Exception error) { host.LogLifecycle($"Host shutdown raised: {error}"); }

        try { window.Shutdown(); }
        catch (Exception error) { host.LogLifecycle($"Window shutdown raised: {error.Message}"); }
        try { trayIcon.Dispose(); }
        catch { }
        try { window.Dispose(); }
        catch { }

        host.LogLifecycle("Desktop resources disposed; terminating UI process.");
        ExitThread();
        Application.ExitThread();
        Environment.Exit(0);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && Interlocked.Exchange(ref exitStarted, 1) == 0)
        {
            activationSignal.Set();
            exitSignal.Set();
            try { trayIcon.Dispose(); } catch { }
            try { window.Dispose(); } catch { }
            try { host.DisposeAsync().AsTask().GetAwaiter().GetResult(); } catch { }
        }
        base.Dispose(disposing);
    }
}

internal sealed class BorgWindow : Form
{
    private readonly BorgHost host;
    private readonly WebView2 browser = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly Label status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font("Segoe UI", 13),
        ForeColor = Color.FromArgb(210, 215, 225),
        BackColor = Color.FromArgb(8, 10, 15),
        Text = "Starting BORG Code…",
    };

    public BorgWindow(BorgHost host)
    {
        this.host = host;
        Text = "BORG Code";
        MinimumSize = new Size(1024, 700);
        Size = new Size(1500, 950);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(8, 10, 15);
        Controls.Add(browser);
        Controls.Add(status);
    }

    public async Task InitializeAsync()
    {
        try
        {
            host.StatusChanged += message =>
            {
                if (!IsDisposed && IsHandleCreated) BeginInvoke(() => status.Text = message);
            };
            var result = await host.StartAsync();
            if (IsDisposed) return;
            status.Text = result.OllamaReady
                ? "Opening BORG Code…"
                : "Opening BORG Code… Ollama is still starting or qwen3-coder:30b is not installed.";

            var userData = Path.Combine(result.RepositoryRoot, ".borg", "webview2");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.Settings.AreDevToolsEnabled = true;
            browser.CoreWebView2.Navigate("http://localhost:5173/");
            browser.Visible = true;
            status.Visible = false;
        }
        catch (Exception error)
        {
            host.LogLifecycle($"Desktop initialization failed: {error}");
            if (!IsDisposed) status.Text = $"BORG Code could not start.\n\n{error.Message}\n\nSee .borg\\desktop for logs.";
        }
    }

    public void Shutdown()
    {
        try { browser.CoreWebView2?.Stop(); } catch { }
        try { browser.Dispose(); } catch { }
        try { Close(); } catch { }
    }
}

internal sealed record StartResult(string RepositoryRoot, bool OllamaReady);
internal sealed record OwnedProcess(string Name, Process Process);

internal sealed class BorgHost : IAsyncDisposable
{
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly List<OwnedProcess> ownedProcesses = [];
    private readonly object processLock = new();
    private readonly string repositoryRoot = RepositoryLocator.Find();
    private readonly string logDirectory;
    private readonly string shutdownSignal;
    private readonly DesktopProcessJob processJob;
    private bool disposed;

    public event Action<string>? StatusChanged;

    public BorgHost()
    {
        logDirectory = Path.Combine(repositoryRoot, ".borg", "desktop");
        shutdownSignal = Path.Combine(logDirectory, "shutdown.signal");
        Directory.CreateDirectory(logDirectory);
        try { if (File.Exists(shutdownSignal)) File.Delete(shutdownSignal); } catch { }
        processJob = new DesktopProcessJob(message => LogLifecycle(message));
    }

    public void LogLifecycle(string message) => AppendLog("lifecycle", message);

    public async Task<StartResult> StartAsync()
    {
        LogLifecycle($"Starting BORG desktop host from {repositoryRoot}.");
        StatusChanged?.Invoke("Starting the local AI runtime…");
        var ollamaReady = await EnsureOllamaAsync();

        StatusChanged?.Invoke("Starting the BORG agent service…");
        await EnsureServiceAsync(
            "api",
            "http://127.0.0.1:4311/health",
            "node.exe",
            "--experimental-strip-types --import ./apps/server/src/desktop-lifecycle-hook.ts --experimental-sqlite apps/server/src/index.ts",
            TimeSpan.FromSeconds(25));

        StatusChanged?.Invoke("Starting the persistent session gateway…");
        await EnsureServiceAsync(
            "gateway",
            "http://127.0.0.1:4312/health",
            "node.exe",
            "--experimental-strip-types --import ./apps/server/src/desktop-lifecycle-hook.ts --experimental-sqlite apps/server/src/desktop-gateway.ts",
            TimeSpan.FromSeconds(25));

        StatusChanged?.Invoke("Starting the BORG workspace…");
        await EnsureServiceAsync(
            "web",
            "http://localhost:5173/",
            "node.exe",
            "--experimental-strip-types --import ./apps/server/src/desktop-lifecycle-hook.ts node_modules/vinext/dist/cli.js dev --port 5173",
            TimeSpan.FromSeconds(75));

        LogLifecycle("Desktop services are ready.");
        return new StartResult(repositoryRoot, ollamaReady);
    }

    private async Task<bool> EnsureOllamaAsync()
    {
        if (await IsHealthyAsync("http://127.0.0.1:11434/api/tags"))
        {
            LogLifecycle("Using an already-running Ollama service; it is not owned by this desktop instance.");
            return true;
        }

        var configured = Environment.GetEnvironmentVariable("BORG_OLLAMA_EXE");
        var candidates = new[]
        {
            configured,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ollama", "ollama.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Ollama", "ollama.exe"),
        }.Where(candidate => !string.IsNullOrWhiteSpace(candidate)).Cast<string>();
        var executable = candidates.FirstOrDefault(File.Exists);
        if (executable is null)
        {
            AppendLog("launcher", "Ollama was not found. Install it or set BORG_OLLAMA_EXE.");
            return false;
        }

        try
        {
            StartOwnedProcess("ollama", executable, "serve");
            return await WaitForAsync("http://127.0.0.1:11434/api/tags", TimeSpan.FromSeconds(30), throwOnTimeout: false);
        }
        catch (Exception error)
        {
            AppendLog("ollama", $"Unable to start Ollama: {error.Message}");
            return false;
        }
    }

    private async Task EnsureServiceAsync(string name, string healthUrl, string executable, string arguments, TimeSpan timeout)
    {
        if (await IsHealthyAsync(healthUrl))
        {
            LogLifecycle($"Service {name} was already healthy and is not adopted as an owned child.");
            return;
        }
        StartOwnedProcess(name, executable, arguments);
        await WaitForAsync(healthUrl, timeout, throwOnTimeout: true);
    }

    private void StartOwnedProcess(string name, string executable, string arguments)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            Arguments = arguments,
            WorkingDirectory = repositoryRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["BORG_DESKTOP_EXE"] = Environment.ProcessPath ?? string.Empty;
        startInfo.Environment["BORG_SHUTDOWN_SIGNAL"] = shutdownSignal;
        startInfo.Environment["BORG_CORE_URL"] = "http://127.0.0.1:4311";

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, eventArgs) => AppendLog(name, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => AppendLog(name, eventArgs.Data);
        process.Exited += (_, _) => LogLifecycle($"Owned process exited: {name} pid={SafeProcessId(process)} code={SafeExitCode(process)}.");
        if (!process.Start()) throw new InvalidOperationException($"Unable to start {name}.");
        processJob.Assign(process, name);
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        lock (processLock) ownedProcesses.Add(new OwnedProcess(name, process));
        LogLifecycle($"Started owned process: {name} pid={process.Id} executable={executable} arguments={arguments}.");
    }

    private async Task<bool> WaitForAsync(string url, TimeSpan timeout, bool throwOnTimeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (await IsHealthyAsync(url)) return true;
            await Task.Delay(500);
        }
        if (throwOnTimeout) throw new TimeoutException($"Timed out waiting for {url}.");
        return false;
    }

    private async Task<bool> IsHealthyAsync(string url)
    {
        try
        {
            using var response = await http.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    private void AppendLog(string name, string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        try { File.AppendAllText(Path.Combine(logDirectory, $"{name}.log"), $"[{DateTimeOffset.Now:O}] {line}{Environment.NewLine}"); }
        catch { }
    }

    private static int SafeProcessId(Process process)
    {
        try { return process.Id; } catch { return -1; }
    }

    private static string SafeExitCode(Process process)
    {
        try { return process.HasExited ? process.ExitCode.ToString() : "running"; } catch { return "unknown"; }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        var started = Stopwatch.StartNew();
        OwnedProcess[] snapshot;
        lock (processLock) snapshot = [.. ownedProcesses];
        LogLifecycle($"Shutdown started with {snapshot.Length} owned process(es).");

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(shutdownSignal)!);
            File.WriteAllText(shutdownSignal, $"{DateTimeOffset.UtcNow:O} {Guid.NewGuid():N}");
            LogLifecycle("Broadcast graceful shutdown signal to BORG child processes.");
        }
        catch (Exception error) { LogLifecycle($"Unable to write shutdown signal: {error.Message}"); }

        var gracefulDeadline = DateTime.UtcNow + TimeSpan.FromSeconds(4);
        foreach (var item in snapshot)
        {
            try
            {
                var remaining = gracefulDeadline - DateTime.UtcNow;
                if (remaining > TimeSpan.Zero && !item.Process.HasExited)
                {
                    using var cts = new CancellationTokenSource(remaining);
                    try { await item.Process.WaitForExitAsync(cts.Token); }
                    catch (OperationCanceledException) { }
                }
            }
            catch (Exception error) { LogLifecycle($"Graceful wait failed for {item.Name}: {error.Message}"); }
        }

        var lingering = snapshot.Where(item =>
        {
            try { return !item.Process.HasExited; } catch { return false; }
        }).ToArray();
        if (lingering.Length > 0)
        {
            LogLifecycle($"{lingering.Length} owned root process(es) still running after grace period; closing Windows job object.");
            processJob.Dispose();
            foreach (var item in lingering)
            {
                try
                {
                    if (!item.Process.HasExited) item.Process.Kill(entireProcessTree: true);
                }
                catch (Exception error) { LogLifecycle($"Fallback kill failed for {item.Name}: {error.Message}"); }
            }
        }
        else processJob.Dispose();

        foreach (var item in snapshot)
        {
            try
            {
                if (!item.Process.HasExited)
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                    try { await item.Process.WaitForExitAsync(cts.Token); } catch (OperationCanceledException) { }
                }
                LogLifecycle($"Shutdown process state: {item.Name} pid={SafeProcessId(item.Process)} exited={item.Process.HasExited} code={SafeExitCode(item.Process)}.");
            }
            catch (Exception error) { LogLifecycle($"Unable to inspect final process state for {item.Name}: {error.Message}"); }
            finally { try { item.Process.Dispose(); } catch { } }
        }

        http.Dispose();
        LogLifecycle($"Host shutdown complete in {started.ElapsedMilliseconds} ms.");
    }
}

internal sealed class DesktopProcessJob : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private readonly Action<string> log;
    private IntPtr handle;

    public DesktopProcessJob(Action<string> log)
    {
        this.log = log;
        if (!OperatingSystem.IsWindows()) return;
        handle = NativeMethods.CreateJobObject(IntPtr.Zero, $"BORG-Code-Children-{Environment.ProcessId}");
        if (handle == IntPtr.Zero)
        {
            log($"CreateJobObject failed: {Marshal.GetLastWin32Error()}.");
            return;
        }
        var info = new NativeMethods.JobObjectExtendedLimitInformation();
        info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        var length = Marshal.SizeOf<NativeMethods.JobObjectExtendedLimitInformation>();
        var pointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, pointer, false);
            if (!NativeMethods.SetInformationJobObject(handle, 9, pointer, (uint)length))
            {
                log($"SetInformationJobObject failed: {Marshal.GetLastWin32Error()}.");
                NativeMethods.CloseHandle(handle);
                handle = IntPtr.Zero;
            }
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public void Assign(Process process, string name)
    {
        if (handle == IntPtr.Zero) return;
        try
        {
            if (!NativeMethods.AssignProcessToJobObject(handle, process.Handle))
                log($"Unable to assign {name} pid={process.Id} to desktop process job: {Marshal.GetLastWin32Error()}.");
            else log($"Assigned {name} pid={process.Id} to desktop process job.");
        }
        catch (Exception error) { log($"Process job assignment failed for {name}: {error.Message}"); }
    }

    public void Dispose()
    {
        var current = Interlocked.Exchange(ref handle, IntPtr.Zero);
        if (current != IntPtr.Zero) NativeMethods.CloseHandle(current);
    }
}

internal static class WindowsCredentialStore
{
    private const uint CredTypeGeneric = 1;
    private const uint CredPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;

    public static string? Read(string target)
    {
        if (!NativeMethods.CredRead(target, CredTypeGeneric, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == ErrorNotFound) return null;
            throw new Win32Exception(error, "Unable to read Windows credential.");
        }
        try
        {
            var credential = Marshal.PtrToStructure<NativeMethods.Credential>(pointer);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return string.Empty;
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.UTF8.GetString(bytes);
        }
        finally { NativeMethods.CredFree(pointer); }
    }

    public static void Write(string target, string secret)
    {
        var targetPointer = Marshal.StringToHGlobalUni(target);
        var userPointer = Marshal.StringToHGlobalUni("BORG Code");
        var bytes = Encoding.UTF8.GetBytes(secret);
        var blobPointer = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blobPointer, bytes.Length);
            var credential = new NativeMethods.Credential
            {
                Type = CredTypeGeneric,
                TargetName = targetPointer,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blobPointer,
                Persist = CredPersistLocalMachine,
                UserName = userPointer,
            };
            if (!NativeMethods.CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to save Windows credential.");
        }
        finally
        {
            for (var index = 0; index < bytes.Length; index++) Marshal.WriteByte(blobPointer, index, 0);
            Marshal.FreeHGlobal(blobPointer);
            Marshal.FreeHGlobal(userPointer);
            Marshal.FreeHGlobal(targetPointer);
            Array.Clear(bytes, 0, bytes.Length);
        }
    }

    public static bool Delete(string target)
    {
        if (NativeMethods.CredDelete(target, CredTypeGeneric, 0)) return true;
        var error = Marshal.GetLastWin32Error();
        if (error == ErrorNotFound) return false;
        throw new Win32Exception(error, "Unable to delete Windows credential.");
    }
}

internal static class NativeMethods
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct Credential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredReadW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CredRead(string target, uint type, uint flags, out IntPtr credentialPointer);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredWriteW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CredDeleteW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    internal static extern void CredFree(IntPtr credentialPointer);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr CreateJobObject(IntPtr securityAttributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);
}

internal static class RepositoryLocator
{
    public static string Find()
    {
        var configured = Environment.GetEnvironmentVariable("BORG_REPOSITORY_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(Path.Combine(configured, "package.json")))
            return Path.GetFullPath(configured);

        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json")) && Directory.Exists(Path.Combine(directory.FullName, "apps")))
                return directory.FullName;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("BORG repository root was not found. Set BORG_REPOSITORY_ROOT to the checkout folder.");
    }
}

internal static class StartupRegistration
{
    private const string StartupFileName = "BORG Code.cmd";
    private static string StartupDirectory => ResolveStartupDirectory();
    private static string StartupFile => Path.Combine(StartupDirectory, StartupFileName);
    public static bool IsEnabled => File.Exists(StartupFile);

    public static void SetEnabled(bool enabled)
    {
        if (enabled)
        {
            var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The desktop executable path is unavailable.");
            Directory.CreateDirectory(StartupDirectory);
            File.WriteAllText(StartupFile, $"@echo off{Environment.NewLine}start \"\" \"{executable}\" --background{Environment.NewLine}");
        }
        else if (File.Exists(StartupFile)) File.Delete(StartupFile);
    }

    private static string ResolveStartupDirectory()
    {
        var startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        if (!string.IsNullOrWhiteSpace(startup)) return startup;
        var appData = Environment.GetEnvironmentVariable("APPDATA");
        if (!string.IsNullOrWhiteSpace(appData)) return Path.Combine(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
        throw new DirectoryNotFoundException("The Windows Startup folder could not be located.");
    }
}

internal static class DesktopShortcut
{
    public static void EnsureExists()
    {
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (string.IsNullOrWhiteSpace(desktop))
        {
            var userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrWhiteSpace(userProfile)) throw new DirectoryNotFoundException("The Windows Desktop folder could not be located.");
            desktop = Path.Combine(userProfile, "Desktop");
        }

        Directory.CreateDirectory(desktop);
        var executable = Environment.ProcessPath ?? throw new InvalidOperationException("The desktop executable path is unavailable.");
        var shellType = Type.GetTypeFromProgID("WScript.Shell") ?? throw new InvalidOperationException("Windows shortcut support is unavailable.");
        object? shell = null;
        object? shortcut = null;
        try
        {
            shell = Activator.CreateInstance(shellType);
            dynamic dynamicShell = shell ?? throw new InvalidOperationException("Windows shortcut support could not start.");
            shortcut = dynamicShell.CreateShortcut(Path.Combine(desktop, "BORG Code.lnk"));
            dynamic dynamicShortcut = shortcut;
            dynamicShortcut.TargetPath = executable;
            dynamicShortcut.WorkingDirectory = RepositoryLocator.Find();
            dynamicShortcut.IconLocation = $"{executable},0";
            dynamicShortcut.Description = "BORG Code local AI engineering workspace";
            dynamicShortcut.Save();
        }
        finally
        {
            if (shortcut is not null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
            if (shell is not null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
        }
    }
}
