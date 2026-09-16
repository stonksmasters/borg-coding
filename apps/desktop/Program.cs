using System.Diagnostics;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BorgCode.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        var command = args.FirstOrDefault();
        if (command is "--install-startup" or "--remove-startup" or "--startup-status")
        {
            if (command == "--install-startup") StartupRegistration.SetEnabled(true);
            if (command == "--remove-startup") StartupRegistration.SetEnabled(false);
            Console.WriteLine(StartupRegistration.IsEnabled ? "enabled" : "disabled");
            return;
        }

        using var activationSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "BORG-Code-Desktop-Activate");
        using var singleInstance = new Mutex(true, "BORG-Code-Desktop", out var firstInstance);
        if (!firstInstance)
        {
            activationSignal.Set();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new BorgApplicationContext(args.Contains("--background"), activationSignal));
    }
}

internal sealed class BorgApplicationContext : ApplicationContext
{
    private readonly BorgHost host = new();
    private readonly BorgWindow window;
    private readonly NotifyIcon trayIcon;
    private readonly EventWaitHandle activationSignal;
    private readonly Thread activationThread;
    private bool exiting;

    public BorgApplicationContext(bool background, EventWaitHandle activationSignal)
    {
        this.activationSignal = activationSignal;
        window = new BorgWindow(host);
        _ = window.Handle;
        try { DesktopShortcut.EnsureExists(); }
        catch
        {
            // A constrained launch may not have permission to repair the Desktop folder.
        }
        try
        {
            if (!StartupRegistration.IsEnabled) StartupRegistration.SetEnabled(true);
        }
        catch
        {
            // A constrained launch may not be allowed to update the Startup folder.
            // The next normal desktop launch will try again.
        }
        var startupItem = new ToolStripMenuItem("Start with Windows")
        {
            Checked = StartupRegistration.IsEnabled,
            CheckOnClick = true,
        };
        var updatingStartupItem = false;
        startupItem.CheckedChanged += (_, _) =>
        {
            if (updatingStartupItem) return;
            try
            {
                StartupRegistration.SetEnabled(startupItem.Checked);
            }
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
        menu.Items.Add("Exit", null, async (_, _) => await ExitAsync());

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
            if (exiting) return;
            eventArgs.Cancel = true;
            window.Hide();
            trayIcon.ShowBalloonTip(1500, "BORG Code", "BORG is still running in the system tray.", ToolTipIcon.Info);
        };

        if (!background) ShowWindow();
        activationThread = new Thread(WaitForActivation)
        {
            IsBackground = true,
            Name = "BORG activation listener",
        };
        activationThread.Start();
        _ = window.InitializeAsync();
    }

    private void WaitForActivation()
    {
        while (!exiting)
        {
            activationSignal.WaitOne();
            if (exiting) return;
            try { window.BeginInvoke(ShowWindow); }
            catch (InvalidOperationException) { return; }
        }
    }

    private void ShowWindow()
    {
        window.Show();
        if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
        window.Activate();
    }

    private async Task ExitAsync()
    {
        exiting = true;
        activationSignal.Set();
        trayIcon.Visible = false;
        await host.DisposeAsync();
        window.Close();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            exiting = true;
            activationSignal.Set();
            trayIcon.Dispose();
            window.Dispose();
            host.DisposeAsync().AsTask().GetAwaiter().GetResult();
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
            host.StatusChanged += message => BeginInvoke(() => status.Text = message);
            var result = await host.StartAsync();
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
            status.Text = $"BORG Code could not start.\n\n{error.Message}\n\nSee .borg\\desktop for logs.";
        }
    }
}

internal sealed record StartResult(string RepositoryRoot, bool OllamaReady);

internal sealed class BorgHost : IAsyncDisposable
{
    private readonly HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly List<Process> ownedProcesses = [];
    private readonly string repositoryRoot = RepositoryLocator.Find();
    private readonly string logDirectory;
    private bool disposed;

    public event Action<string>? StatusChanged;

    public BorgHost()
    {
        logDirectory = Path.Combine(repositoryRoot, ".borg", "desktop");
        Directory.CreateDirectory(logDirectory);
    }

    public async Task<StartResult> StartAsync()
    {
        StatusChanged?.Invoke("Starting the local AI runtime…");
        var ollamaReady = await EnsureOllamaAsync();

        StatusChanged?.Invoke("Starting the BORG agent service…");
        await EnsureServiceAsync(
            "api",
            "http://127.0.0.1:4311/health",
            "node.exe",
            "--experimental-strip-types --experimental-sqlite apps/server/src/index.ts",
            TimeSpan.FromSeconds(25));

        StatusChanged?.Invoke("Starting the BORG workspace…");
        await EnsureServiceAsync(
            "web",
            "http://localhost:5173/",
            "node.exe",
            "node_modules/vinext/dist/cli.js dev --port 5173",
            TimeSpan.FromSeconds(75));

        return new StartResult(repositoryRoot, ollamaReady);
    }

    private async Task<bool> EnsureOllamaAsync()
    {
        if (await IsHealthyAsync("http://127.0.0.1:11434/api/tags")) return true;

        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Ollama", "ollama.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Ollama", "ollama.exe"),
        };
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
        if (await IsHealthyAsync(healthUrl)) return;
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
        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, eventArgs) => AppendLog(name, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => AppendLog(name, eventArgs.Data);
        if (!process.Start()) throw new InvalidOperationException($"Unable to start {name}.");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        ownedProcesses.Add(process);
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
        catch
        {
            return false;
        }
    }

    private void AppendLog(string name, string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        try
        {
            File.AppendAllText(Path.Combine(logDirectory, $"{name}.log"), $"[{DateTimeOffset.Now:O}] {line}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never crash the launcher.
        }
    }

    public ValueTask DisposeAsync()
    {
        if (disposed) return ValueTask.CompletedTask;
        disposed = true;
        foreach (var process in ownedProcesses)
        {
            try
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                process.Dispose();
            }
            catch
            {
                // A process may have already stopped or be owned by Windows.
            }
        }
        http.Dispose();
        return ValueTask.CompletedTask;
    }
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
        if (!string.IsNullOrWhiteSpace(appData))
            return Path.Combine(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
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
