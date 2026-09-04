## App name

OpenCode Mobile

## Subtitle

OpenCode sunucuları için mobil istemci

## Promotional text

Telefonunuzdan OpenCode ajanlarınızla sohbet edin; konuşmalarınıza bilgisayar ve iPhone arasında kesintisiz devam edin.

## Keywords

opencode, mobile, ai, agent, client, kodlama, kod, sunucu, uzaktan

## Description

OpenCode Mobile, OpenCode ajanlarınızı iPhone’a taşır. Uygulamayı bilgisayarınızda çalışan OpenCode sunucusuna bağlayın; nerede olursanız olun kodunuz ve geliştirme araçlarınızla çalışmaya devam edin.

Bilgisayar ve telefon arasında akıcı şekilde geçiş yapın: masaüstünde başlattığınız oturumları iPhone’da sürdürün ya da mobilde başlattığınız bir konuşmaya bilgisayarınızdan geri dönün.

(Bu bağımsız, açık kaynaklı bir topluluk projesidir. Resmî bir uygulama değildir ve opencode.ai ile bağlantısı yoktur.)

ÖZELLİKLER:

◆ Herhangi bir OpenCode sunucusuna HTTP veya HTTPS ile bağlanın; yerel ağda ya da VPN veya Tailscale üzerinden uzaktan çalışın.
◆ Birden fazla sunucu profili oluşturun ve tercih ettiğiniz sunucuya otomatik bağlanın.
◆ OPENCODE_SERVER_PASSWORD ile yapılandırılmış OpenCode sunucuları dahil Basic Auth desteği.
◆ Sunucuları uygulama içinden yönetin: aşağı çekin, yenileyin veya menüyü açın.
◆ Otomatik sunucu durum kontrolleri ve giderek artan bekleme süreleriyle yeniden bağlanma.
◆ Parolalar Keychain’de güvenle saklanır.
◆ Sistem ayarlarına otomatik uyum sağlayan açık ve koyu tema.
◆ İsteğe bağlı yazım modu: Enter yeni satır ekler, Shift+Enter mesajı gönderir.
◆ AÇIK KAYNAK

Bir sorun mu buldunuz, yoksa geliştirme fikriniz mi var?

GitHub’da issue bildirebilir, özellik önerebilir veya pull request gönderebilirsiniz.

GitHub deposu:
https://github.com/bmpenuelas/opencode-mobile-client

HIZLI BAŞLANGIÇ:

Uygulamayı kullanmak için çalışan bir OpenCode sunucusu gerekir.

OpenCode Mobile, kodunuzun ve geliştirme araçlarınızın bulunduğu bilgisayarda çalışan OpenCode web sunucusuna bağlanan bir istemcidir.

► Kimlik doğrulama olmadan

opencode web --hostname 0.0.0.0 --port 4096

► Kimlik doğrulama ile

Sunucu güvenilir yerel ağınızın dışından erişilebiliyorsa kimlik doğrulama kullanmanız önerilir.

export OPENCODE_SERVER_PASSWORD="your-secret-password"

opencode serve --hostname 0.0.0.0 --port 4096

Kimlik doğrulama etkin olduğunda uygulamadaki varsayılan kullanıcı adı opencode olur.
