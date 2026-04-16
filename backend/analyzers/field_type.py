from enum import Enum

class FieldType(str, Enum):
    # ── テキストフィールド ──
    COMPANY_NAME = "company_name" # 会社名
    PERSON_NAME = "person_name" # 氏名
    DEPARTMENT = "department" # 部署
    POSITION = "position" # 役職
    ADDRESS = "address" # 住所
    POSTAL_CODE = "postal_code" # 郵便番号（〒符号）
    TEL = "tel" # 電話番号（手書き、印刷問わず）
    FAX = "fax" # FAX番号（手書き、印刷問わず）
    EMAIL = "email" # メールアドレス（ロゴ内、手書き、印刷問わず）
    URL = "url" # URL
    CATCH_COPY = "catch_copy" # キャッチコピー
    OTHER = "other" # 上記以外のすべてのテキスト
    
    # ── 画像フィールド ──
    FACE_PHOTO = "face_photo" # 顔写真
    LOGO_SYMBOL = "logo_symbol" # ロゴのシンボル部分
    STAMP = "stamp" # 印鑑
