using System.Security.Cryptography;
using System.Text;
using PcManager.Server.Contracts;

namespace PcManager.Server.Services;

/// <summary>
/// 텍스트 편집용 인코딩 판별/복원. 읽을 때 인코딩·줄바꿈을 알아내고, 저장할 때 같은 형식으로 되돌린다
/// (한글 윈도우의 CP949 파일이 UTF-8로 바뀌어 깨지지 않게).
/// </summary>
public static class TextCodec
{
    /// <summary>브라우저에서 편집할 수 있는 최대 크기</summary>
    public const int MaxBytes = 5 * 1024 * 1024;

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    static TextCodec()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
    }

    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    /// <summary>텍스트가 아니면(바이너리) null</summary>
    public static TextFileView? Decode(byte[] bytes)
    {
        string encoding;
        string text;
        if (bytes.AsSpan().StartsWith((byte[])[0xEF, 0xBB, 0xBF]))
        {
            encoding = "utf-8-bom";
            text = Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        }
        else if (bytes.AsSpan().StartsWith((byte[])[0xFF, 0xFE]))
        {
            encoding = "utf-16le";
            text = Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        }
        else if (bytes.AsSpan().StartsWith((byte[])[0xFE, 0xFF]))
        {
            encoding = "utf-16be";
            text = Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        }
        else
        {
            // NUL 문자가 있으면 바이너리로 본다
            if (bytes.AsSpan(0, Math.Min(bytes.Length, 8000)).Contains((byte)0))
                return null;
            try
            {
                text = StrictUtf8.GetString(bytes);
                encoding = "utf-8";
            }
            catch (DecoderFallbackException)
            {
                text = Encoding.GetEncoding(949).GetString(bytes);
                encoding = "cp949";
            }
        }

        var crlf = 0;
        var lf = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '\n')
                continue;
            if (i > 0 && text[i - 1] == '\r')
                crlf++;
            else
                lf++;
        }
        // 줄바꿈이 없으면 윈도우 기본(CRLF)
        var newline = lf > crlf ? "\n" : "\r\n";
        return new TextFileView(text.Replace("\r\n", "\n"), encoding, newline, Hash(bytes), bytes.Length);
    }

    /// <summary>편집기 내용(줄바꿈 \n)을 원래 인코딩·줄바꿈으로 바이트로 만든다.</summary>
    public static byte[] Encode(string content, string? encoding, string? newline)
    {
        var text = content.Replace("\r\n", "\n");
        if (newline == "\r\n")
            text = text.Replace("\n", "\r\n");
        return encoding switch
        {
            "utf-8-bom" => [.. Encoding.UTF8.GetPreamble(), .. Encoding.UTF8.GetBytes(text)],
            "utf-16le" => [.. Encoding.Unicode.GetPreamble(), .. Encoding.Unicode.GetBytes(text)],
            "utf-16be" => [.. Encoding.BigEndianUnicode.GetPreamble(), .. Encoding.BigEndianUnicode.GetBytes(text)],
            "cp949" => Encoding.GetEncoding(949).GetBytes(text),
            _ => Encoding.UTF8.GetBytes(text),
        };
    }
}
