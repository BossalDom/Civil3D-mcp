using System.Collections.Concurrent;

namespace Civil3DMcpPlugin;

public sealed class JobRecord
{
  public required string JobId { get; init; }
  public required string State { get; set; }
  public int? ProgressPercent { get; set; }
  public string? CurrentPhase { get; set; }
  public int? EstimatedRemainingSeconds { get; set; }
  public object? Result { get; set; }
  public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
  public DateTimeOffset? CompletedAt { get; set; }
  public CancellationTokenSource? CancellationSource { get; set; }
}

public static class JobRegistry
{
  private static readonly ConcurrentDictionary<string, JobRecord> Jobs = new();

  public static JobRecord Create(string currentPhase)
  {
    var record = new JobRecord
    {
      JobId = Guid.NewGuid().ToString("N"),
      State = "running",
      ProgressPercent = 0,
      CurrentPhase = currentPhase,
      EstimatedRemainingSeconds = null,
    };

    Jobs[record.JobId] = record;
    return record;
  }

  public static JobRecord Complete(string jobId, object? result)
  {
    if (!Jobs.TryGetValue(jobId, out var record))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.OBJECT_NOT_FOUND",
        $"Job '{jobId}' was not found when completing.");
    }

    record.State = "completed";
    record.ProgressPercent = 100;
    record.EstimatedRemainingSeconds = 0;
    record.Result = result;
    record.CompletedAt = DateTimeOffset.UtcNow;
    return record;
  }

  public static JobRecord Fail(string jobId, string errorMessage)
  {
    if (!Jobs.TryGetValue(jobId, out var record))
    {
      throw new JsonRpcDispatchException(
        "CIVIL3D.OBJECT_NOT_FOUND",
        $"Job '{jobId}' was not found when failing.");
    }

    record.State = "failed";
    record.CurrentPhase = null;
    record.EstimatedRemainingSeconds = 0;
    record.Result = new Dictionary<string, object?>
    {
      ["error"] = errorMessage,
    };
    record.CompletedAt = DateTimeOffset.UtcNow;
    return record;
  }

  // Drop completed/failed/cancelled records older than the cutoff so the
  // registry doesn't grow unbounded across long sessions. Running jobs are
  // preserved regardless of age.
  public static int PurgeTerminalJobsOlderThan(DateTimeOffset cutoff)
  {
    var removed = 0;

    foreach (var entry in Jobs.ToArray())
    {
      var state = entry.Value.State;
      var isTerminal = state is "completed" or "failed" or "cancelled";
      if (isTerminal
        && entry.Value.CompletedAt is { } completedAt
        && completedAt < cutoff
        && Jobs.TryRemove(entry.Key, out _))
      {
        removed++;
      }
    }

    return removed;
  }

  public static JobRecord Get(string jobId)
  {
    if (!Jobs.TryGetValue(jobId, out var record))
    {
      throw new JsonRpcDispatchException("CIVIL3D.OBJECT_NOT_FOUND", $"Job '{jobId}' was not found.");
    }

    return record;
  }

  public static JobRecord Cancel(string jobId)
  {
    var record = Get(jobId);
    if (record.State == "running")
    {
      record.State = "cancelled";
      record.CurrentPhase = null;
      record.EstimatedRemainingSeconds = null;
      record.CompletedAt = DateTimeOffset.UtcNow;

      // Signal the background worker (if any) to stop. Safe to call even if
      // the worker has already completed; CancellationTokenSource tolerates it.
      try
      {
        record.CancellationSource?.Cancel();
      }
      catch (ObjectDisposedException)
      {
        // Token source was already disposed by a completing worker; nothing to do.
      }
    }

    return record;
  }

  public static void Progress(string jobId, int? progressPercent, string? currentPhase, int? estimatedRemainingSeconds)
  {
    if (!Jobs.TryGetValue(jobId, out var record))
    {
      return;
    }

    if (progressPercent.HasValue)
    {
      record.ProgressPercent = Math.Clamp(progressPercent.Value, 0, 100);
    }

    if (!string.IsNullOrWhiteSpace(currentPhase))
    {
      record.CurrentPhase = currentPhase;
    }

    if (estimatedRemainingSeconds.HasValue)
    {
      record.EstimatedRemainingSeconds = Math.Max(0, estimatedRemainingSeconds.Value);
    }
  }
}
