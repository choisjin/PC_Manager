namespace PcManager.Server.Contracts;

/// <summary>파일 즐겨찾기 하나. 어느 PC(또는 공유 폴더)의 파일인지 늘 함께 둔다</summary>
/// <param name="SourceId">에이전트 id 또는 공유 폴더 id</param>
/// <param name="SourceName">추가할 때의 PC 이름(별칭)·공유 폴더 이름 (PC가 지워져도 어디 것이었는지 보이게)</param>
/// <param name="IsShare">공유 폴더 파일: 내 PC에서 네트워크 경로로 바로 연다. 아니면 내 PC 프로그램으로 열기(저장하면 원래 PC에)</param>
/// <param name="Path">파일 전체 경로</param>
public record FileFavorite(string Id, string SourceId, string SourceName, bool IsShare, string Path, DateTimeOffset AddedAt);

public record FileFavoritesView(IReadOnlyList<FileFavorite> Items);

/// <summary>즐겨찾기 파일을 지금 열 수 있는지. 못 열면 이유</summary>
public record FileFavoriteAccess(bool Ok, string? Reason);

/// <summary>공유 폴더 파일을 내 PC(editorAgentId)에서 네트워크 경로로 바로 연다</summary>
public record OpenShareDirectRequest(string? Path, string? EditorAgentId);
