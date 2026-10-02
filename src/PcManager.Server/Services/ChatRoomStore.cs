using System.Text.Json;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 채팅방(1:1·그룹)과 메시지 저장소.
/// - 방 목록·구성원·읽음 위치: chat-rooms.json
/// - 메시지: chat-room-messages.jsonl (덧붙이기, 방마다 최근 MaxPerRoom개만 보관)
/// 1:1 방 id는 두 사용자 id로 정해진다(dm:작은id:큰id) — 같은 두 사람은 항상 같은 방.
/// 그룹 방: 초대는 구성원 누구나, 강퇴는 방장만. 방장이 나가면 가장 먼저 들어온 사람이 방장.
/// </summary>
public class ChatRoomStore(AppPaths paths)
{
    private const int MaxPerRoom = 500;
    private const int MaxLength = 2000;
    private const int MaxNameLength = 40;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = false };

    private readonly Lock _lock = new();
    private readonly string _roomsPath = Path.Combine(paths.DataDirectory, "chat-rooms.json");
    private readonly string _messagesPath = Path.Combine(paths.DataDirectory, "chat-room-messages.jsonl");

    private Dictionary<string, Room>? _rooms;
    private Dictionary<string, List<ChatRoomMessageView>>? _messages;
    private long _nextId;
    private int _appendedSinceCompact;

    [System.Reflection.Obfuscation(Exclude = true, ApplyToMembers = true)]
    private sealed class Room
    {
        public required string Id { get; init; }
        public required string Kind { get; init; }
        public string? Name { get; set; }
        public string? OwnerId { get; set; }
        public List<ChatMemberView> Members { get; set; } = [];
        public DateTime CreatedAt { get; init; }
        public Dictionary<string, long> Reads { get; set; } = [];
    }

    public static string DirectId(string a, string b) =>
        string.CompareOrdinal(a, b) < 0 ? $"dm:{a}:{b}" : $"dm:{b}:{a}";

    /// <summary>이 사용자가 속한 방 (최근 대화 순)</summary>
    public IReadOnlyList<ChatRoomView> RoomsFor(string userId)
    {
        lock (_lock)
        {
            return Rooms().Values
                .Where(r => IsMember(r, userId))
                .Select(r => ToView(r, userId))
                .OrderByDescending(v => v.LastMessage?.At ?? v.CreatedAt)
                .ToList();
        }
    }

    public ChatRoomView? RoomFor(string roomId, string userId)
    {
        lock (_lock)
        {
            return Rooms().TryGetValue(roomId, out var r) && IsMember(r, userId) ? ToView(r, userId) : null;
        }
    }

    /// <summary>방 구성원 id (알림 대상)</summary>
    public IReadOnlyList<string> MembersOf(string roomId)
    {
        lock (_lock)
        {
            return Rooms().TryGetValue(roomId, out var r) ? r.Members.Select(m => m.UserId).ToList() : [];
        }
    }

    public IReadOnlyList<ChatRoomMessageView> Messages(string roomId, string userId, int take)
    {
        lock (_lock)
        {
            if (!Rooms().TryGetValue(roomId, out var r) || !IsMember(r, userId))
                throw new KeyNotFoundException("채팅방을 찾을 수 없습니다.");
            var list = MessagesOf(roomId);
            return list.Skip(Math.Max(0, list.Count - take)).ToList();
        }
    }

    public ChatRoomView CreateGroup(string userId, string name, IReadOnlyList<string> memberIds)
    {
        var cleanName = CleanName(name);
        lock (_lock)
        {
            var now = DateTime.UtcNow;
            var room = new Room
            {
                Id = "g:" + Guid.NewGuid().ToString("N"),
                Kind = "group",
                Name = cleanName,
                OwnerId = userId,
                CreatedAt = now,
                Members = [new ChatMemberView(userId, now)],
            };
            foreach (var id in memberIds.Where(id => !string.IsNullOrWhiteSpace(id) && id != userId).Distinct())
                room.Members.Add(new ChatMemberView(id, now));
            Rooms()[room.Id] = room;
            SaveRooms();
            return ToView(room, userId);
        }
    }

    /// <summary>1:1 방을 연다 (없으면 만든다)</summary>
    public ChatRoomView OpenDirect(string userId, string otherId)
    {
        if (string.IsNullOrWhiteSpace(otherId) || otherId == userId)
            throw new ArgumentException("대화할 상대를 고르세요.");
        lock (_lock)
        {
            var id = DirectId(userId, otherId);
            if (!Rooms().TryGetValue(id, out var room))
            {
                var now = DateTime.UtcNow;
                room = new Room
                {
                    Id = id,
                    Kind = "direct",
                    CreatedAt = now,
                    Members = [new ChatMemberView(userId, now), new ChatMemberView(otherId, now)],
                };
                Rooms()[id] = room;
                SaveRooms();
            }
            return ToView(room, userId);
        }
    }

    /// <summary>초대 (그룹 방 구성원 누구나). 시스템 안내 메시지를 함께 돌려준다</summary>
    public (ChatRoomView Room, ChatRoomMessageView? Notice, IReadOnlyList<string> Added) Invite(
        string userId, string roomId, IReadOnlyList<string> userIds, Func<string, string> nameOf)
    {
        lock (_lock)
        {
            var room = GroupFor(roomId, userId);
            var now = DateTime.UtcNow;
            var added = userIds.Where(id => !string.IsNullOrWhiteSpace(id) && !IsMember(room, id)).Distinct().ToList();
            foreach (var id in added)
                room.Members.Add(new ChatMemberView(id, now));
            if (added.Count == 0)
                return (ToView(room, userId), null, added);
            SaveRooms();
            var notice = AppendUnlocked(room.Id, null, $"{nameOf(userId)}님이 {string.Join(", ", added.Select(nameOf))}님을 초대했습니다.", null);
            return (ToView(room, userId), notice, added);
        }
    }

    /// <summary>강퇴 (방장만)</summary>
    public (ChatRoomView Room, ChatRoomMessageView Notice) Kick(string userId, string roomId, string targetId, Func<string, string> nameOf)
    {
        lock (_lock)
        {
            var room = GroupFor(roomId, userId);
            if (room.OwnerId != userId)
                throw new InvalidOperationException("방장만 내보낼 수 있습니다.");
            if (targetId == userId)
                throw new InvalidOperationException("자신은 내보낼 수 없습니다. 나가기를 쓰세요.");
            if (room.Members.RemoveAll(m => m.UserId == targetId) == 0)
                throw new KeyNotFoundException("구성원이 아닙니다.");
            room.Reads.Remove(targetId);
            SaveRooms();
            var notice = AppendUnlocked(room.Id, null, $"{nameOf(userId)}님이 {nameOf(targetId)}님을 내보냈습니다.", null);
            return (ToView(room, userId), notice);
        }
    }

    /// <summary>나가기. 방장이 나가면 가장 먼저 들어온 사람이 방장. 아무도 없으면 방을 지운다</summary>
    /// <returns>남은 방(없으면 null)과 안내 메시지</returns>
    public (ChatRoomView? Room, ChatRoomMessageView? Notice) Leave(string userId, string roomId, Func<string, string> nameOf)
    {
        lock (_lock)
        {
            var room = GroupFor(roomId, userId);
            room.Members.RemoveAll(m => m.UserId == userId);
            room.Reads.Remove(userId);
            if (room.Members.Count == 0)
            {
                Rooms().Remove(room.Id);
                Messages().Remove(room.Id);
                SaveRooms();
                return (null, null);
            }
            var text = $"{nameOf(userId)}님이 나갔습니다.";
            if (room.OwnerId == userId)
            {
                var next = room.Members.OrderBy(m => m.JoinedAt).First();
                room.OwnerId = next.UserId;
                text += $" 방장: {nameOf(next.UserId)}";
            }
            SaveRooms();
            var notice = AppendUnlocked(room.Id, null, text, null);
            return (ToView(room, room.OwnerId!), notice);
        }
    }

    public (ChatRoomView Room, ChatRoomMessageView Notice) Rename(string userId, string roomId, string name, Func<string, string> nameOf)
    {
        var cleanName = CleanName(name);
        lock (_lock)
        {
            var room = GroupFor(roomId, userId);
            if (room.OwnerId != userId)
                throw new InvalidOperationException("방장만 이름을 바꿀 수 있습니다.");
            room.Name = cleanName;
            SaveRooms();
            var notice = AppendUnlocked(room.Id, null, $"{nameOf(userId)}님이 방 이름을 '{cleanName}'(으)로 바꿨습니다.", null);
            return (ToView(room, userId), notice);
        }
    }

    public ChatRoomMessageView Send(string userId, string roomId, string text, IReadOnlyList<string>? mentions)
    {
        text = text.Trim();
        if (text.Length == 0)
            throw new ArgumentException("빈 메시지입니다.");
        if (text.Length > MaxLength)
            text = text[..MaxLength];
        lock (_lock)
        {
            if (!Rooms().TryGetValue(roomId, out var room) || !IsMember(room, userId))
                throw new KeyNotFoundException("채팅방을 찾을 수 없습니다.");
            var message = AppendUnlocked(roomId, userId, text, mentions?.Where(id => IsMember(room, id)).Distinct().Take(50).ToList());
            // 보낸 메시지는 읽은 것으로
            room.Reads[userId] = message.Id;
            SaveRooms();
            return message;
        }
    }

    /// <returns>읽음 위치가 바뀌었으면 true</returns>
    public bool MarkRead(string userId, string roomId, long messageId)
    {
        lock (_lock)
        {
            if (!Rooms().TryGetValue(roomId, out var room) || !IsMember(room, userId))
                return false;
            if (room.Reads.TryGetValue(userId, out var current) && current >= messageId)
                return false;
            room.Reads[userId] = messageId;
            SaveRooms();
            return true;
        }
    }

    // ── 내부 ──

    private static bool IsMember(Room room, string userId) => room.Members.Any(m => m.UserId == userId);

    private Room GroupFor(string roomId, string userId)
    {
        if (!Rooms().TryGetValue(roomId, out var room) || !IsMember(room, userId))
            throw new KeyNotFoundException("채팅방을 찾을 수 없습니다.");
        if (room.Kind != "group")
            throw new InvalidOperationException("1:1 대화에서는 할 수 없습니다.");
        return room;
    }

    private static string CleanName(string name)
    {
        var n = (name ?? "").Trim();
        if (n.Length == 0)
            throw new ArgumentException("채팅방 이름을 입력하세요.");
        return n.Length > MaxNameLength ? n[..MaxNameLength] : n;
    }

    private ChatRoomView ToView(Room room, string userId)
    {
        var list = MessagesOf(room.Id);
        var read = room.Reads.TryGetValue(userId, out var r) ? r : 0;
        var unread = list.Count(m => m.Id > read && m.UserId is not null && m.UserId != userId);
        return new ChatRoomView(room.Id, room.Kind, room.Name, room.OwnerId, room.Members.ToList(), room.CreatedAt,
            new Dictionary<string, long>(room.Reads), list.Count > 0 ? list[^1] : null, unread);
    }

    private ChatRoomMessageView AppendUnlocked(string roomId, string? userId, string text, IReadOnlyList<string>? mentions)
    {
        Messages();
        var message = new ChatRoomMessageView(++_nextId, roomId, userId, text, DateTime.UtcNow, mentions);
        var list = MessagesOf(roomId);
        list.Add(message);
        if (list.Count > MaxPerRoom)
            list.RemoveRange(0, list.Count - MaxPerRoom);
        Directory.CreateDirectory(Path.GetDirectoryName(_messagesPath)!);
        File.AppendAllText(_messagesPath, JsonSerializer.Serialize(message, Json) + Environment.NewLine);
        // 지워진 방·오래된 메시지가 파일에 쌓이지 않게 가끔 다시 쓴다
        if (++_appendedSinceCompact >= 1000)
            Compact();
        return message;
    }

    private List<ChatRoomMessageView> MessagesOf(string roomId)
    {
        var all = Messages();
        if (!all.TryGetValue(roomId, out var list))
            all[roomId] = list = [];
        return list;
    }

    private Dictionary<string, Room> Rooms()
    {
        if (_rooms is not null)
            return _rooms;
        _rooms = [];
        try
        {
            if (File.Exists(_roomsPath))
                foreach (var room in JsonSerializer.Deserialize<List<Room>>(File.ReadAllText(_roomsPath), Json) ?? [])
                    _rooms[room.Id] = room;
        }
        catch (JsonException)
        {
            // 깨졌으면 새로 시작
        }
        return _rooms;
    }

    private Dictionary<string, List<ChatRoomMessageView>> Messages()
    {
        if (_messages is not null)
            return _messages;
        _messages = [];
        if (File.Exists(_messagesPath))
        {
            foreach (var line in File.ReadLines(_messagesPath))
            {
                try
                {
                    if (JsonSerializer.Deserialize<ChatRoomMessageView>(line, Json) is not { } m)
                        continue;
                    if (!_messages.TryGetValue(m.RoomId, out var list))
                        _messages[m.RoomId] = list = [];
                    list.Add(m);
                    _nextId = Math.Max(_nextId, m.Id);
                }
                catch (JsonException)
                {
                    // 깨진 줄은 건너뛴다
                }
            }
            foreach (var list in _messages.Values.Where(l => l.Count > MaxPerRoom))
                list.RemoveRange(0, list.Count - MaxPerRoom);
        }
        return _messages;
    }

    private void Compact()
    {
        _appendedSinceCompact = 0;
        var rooms = Rooms();
        var temp = _messagesPath + ".tmp";
        File.WriteAllLines(temp, Messages()
            .Where(kv => rooms.ContainsKey(kv.Key))
            .SelectMany(kv => kv.Value)
            .OrderBy(m => m.Id)
            .Select(m => JsonSerializer.Serialize(m, Json)));
        File.Move(temp, _messagesPath, overwrite: true);
    }

    private void SaveRooms()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_roomsPath)!);
        var temp = _roomsPath + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(Rooms().Values.ToList(), Json));
        File.Move(temp, _roomsPath, overwrite: true);
    }
}
