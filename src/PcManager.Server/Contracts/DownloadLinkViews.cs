namespace PcManager.Server.Contracts;

/// <summary>공개 다운로드 링크 (토큰만 알면 누구나 받을 수 있음)</summary>
public record DownloadLink(string Token, string AgentId, string Path, string Name, DateTime CreatedAt);

public record CreateDownloadLinkRequest(string? Path);

public record DownloadLinkView(string Token, string Url, string Name);
