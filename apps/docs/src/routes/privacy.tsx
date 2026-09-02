import { createFileRoute } from "@tanstack/react-router";

import ContentPage from "@/components/sections/content-page";
import { createSeoHead } from "@/lib/seo";

const RouteComponent = () => (
    <ContentPage>
        <h1>Privacy Policy</h1>

        <h2>1. An overview of data protection</h2>

        <h3>General information</h3>
        <p>
            The following information will provide you with an easy to navigate overview of what will happen with your personal data when you visit this
            website. The term &ldquo;personal data&rdquo; comprises all data that can be used to personally identify you. For detailed information about the
            subject matter of data protection, please consult our Data Protection Declaration, which we have included beneath this copy.
        </p>

        <h3>Data recording on this website</h3>

        <h4>Who is the responsible party for the recording of data on this website (i.e., the &ldquo;controller&rdquo;)?</h4>
        <p>
            The data on this website is processed by the operator of the website, whose contact information is available under section &ldquo;Information about
            the responsible party (referred to as the &ldquo;controller&rdquo; in the GDPR)&rdquo; in this Privacy Policy.
        </p>

        <h4>How do we record your data?</h4>
        <p>We collect your data as a result of your sharing of your data with us. This may, for instance be information you enter into our contact form.</p>
        <p>
            Other data shall be recorded by our IT systems automatically or after you consent to its recording during your website visit. This data comprises
            primarily technical information (e.g., web browser, operating system, or time the site was accessed). This information is recorded automatically
            when you access this website.
        </p>

        <h4>What are the purposes we use your data for?</h4>
        <p>
            A portion of the information is generated to guarantee the error free provision of the website. Other data may be used to analyze your user
            patterns. If contracts can be concluded or initiated via the website, the transmitted data will also be processed for contract offers, orders or
            other order enquiries.
        </p>

        <h4>What rights do you have as far as your information is concerned?</h4>
        <p>
            You have the right to receive information about the source, recipients, and purposes of your archived personal data at any time without having to
            pay a fee for such disclosures. You also have the right to demand that your data are rectified or eradicated. If you have consented to data
            processing, you have the option to revoke this consent at any time, which shall affect all future data processing. Moreover, you have the right to
            demand that the processing of your data be restricted under certain circumstances. Furthermore, you have the right to log a complaint with the
            competent supervising agency.
        </p>
        <p>Please do not hesitate to contact us at any time if you have questions about this or any other data protection related issues.</p>

        <h3>Analysis tools and tools provided by third parties</h3>
        <p>
            There is a possibility that your browsing patterns will be statistically analyzed when your visit this website. Such analyses are performed
            primarily with what we refer to as analysis programs.
        </p>
        <p>For detailed information about these analysis programs please consult our Data Protection Declaration below.</p>

        <h2>2. Hosting</h2>
        <p>We are hosting the content of our website at the following provider:</p>

        <h3>External Hosting</h3>
        <p>
            This website is hosted externally. Personal data collected on this website are stored on the servers of the host. These may include, but are not
            limited to, IP addresses, contact requests, metadata and communications, contract information, contact information, names, web page access, and
            other data generated through a web site.
        </p>
        <p>
            The external hosting serves the purpose of fulfilling the contract with our potential and existing customers (Art. 6(1)(b) GDPR) and in the interest
            of secure, fast, and efficient provision of our online services by a professional provider (Art. 6(1)(f) GDPR). If appropriate consent has been
            obtained, the processing is carried out exclusively on the basis of Art. 6 (1)(a) GDPR and &sect; 25 (1) TDDDG, insofar the consent includes the
            storage of cookies or the access to information in the user&rsquo;s end device (e.g., device fingerprinting) within the meaning of the TDDDG. This
            consent can be revoked at any time.
        </p>
        <p>
            Our host(s) will only process your data to the extent necessary to fulfil its performance obligations and to follow our instructions with respect to
            such data.
        </p>
        <p>We are using the following host(s):</p>
        <p>
            Netlify
            <br />
            44 Montgomery St Suite 300,
            <br />
            San Francisco, California 94104, US
        </p>

        <h2>3. General information and mandatory information</h2>

        <h3>Data protection</h3>
        <p>
            The operators of this website and its pages take the protection of your personal data very seriously. Hence, we handle your personal data as
            confidential information and in compliance with the statutory data protection regulations and this Data Protection Declaration.
        </p>
        <p>
            Whenever you use this website, a variety of personal information will be collected. Personal data comprises data that can be used to personally
            identify you. This Data Protection Declaration explains which data we collect as well as the purposes we use this data for. It also explains how,
            and for which purpose the information is collected.
        </p>
        <p>
            We herewith advise you that the transmission of data via the Internet (i.e., through e-mail communications) may be prone to security gaps. It is not
            possible to completely protect data against third-party access.
        </p>

        <h3>Information about the responsible party (referred to as the &ldquo;controller&rdquo; in the GDPR)</h3>
        <p>The data processing controller on this website is:</p>
        <p>
            danielbannert.com - Daniel Bannert
            <br />
            c/o Online-Impressum.de #22125
            <br />
            Europaring 90
            <br />
            53757 Sankt Augustin
        </p>
        <p>E-mail: d.bannert@anolilab.de</p>
        <p>
            The controller is the natural person or legal entity that single-handedly or jointly with others makes decisions as to the purposes of and resources
            for the processing of personal data (e.g., names, e-mail addresses, etc.).
        </p>

        <h3>Storage duration</h3>
        <p>
            Unless a more specific storage period has been specified in this privacy policy, your personal data will remain with us until the purpose for which
            it was collected no longer applies. If you assert a justified request for deletion or revoke your consent to data processing, your data will be
            deleted, unless we have other legally permissible reasons for storing your personal data (e.g., tax or commercial law retention periods); in the
            latter case, the deletion will take place after these reasons cease to apply.
        </p>

        <h3>General information on the legal basis for the data processing on this website</h3>
        <p>
            If you have consented to data processing, we process your personal data on the basis of Art. 6(1)(a) GDPR or Art. 9 (2)(a) GDPR, if special
            categories of data are processed according to Art. 9 (1) DSGVO. In the case of explicit consent to the transfer of personal data to third countries,
            the data processing is also based on Art. 49 (1)(a) GDPR. If you have consented to the storage of cookies or to the access to information in your
            end device (e.g., via device fingerprinting), the data processing is additionally based on &sect; 25 (1) TDDDG. The consent can be revoked at any
            time. If your data is required for the fulfillment of a contract or for the implementation of pre-contractual measures, we process your data on the
            basis of Art. 6(1)(b) GDPR. Furthermore, if your data is required for the fulfillment of a legal obligation, we process it on the basis of Art.
            6(1)(c) GDPR. Furthermore, the data processing may be carried out on the basis of our legitimate interest according to Art. 6(1)(f) GDPR.
            Information on the relevant legal basis in each individual case is provided in the following paragraphs of this privacy policy.
        </p>

        <h3>Recipients of personal data</h3>
        <p>
            In the scope of our business activities, we cooperate with various external parties. In some cases, this also requires the transfer of personal data
            to these external parties. We only disclose personal data to external parties if this is required as part of the fulfillment of a contract, if we
            are legally obligated to do so (e.g., disclosure of data to tax authorities), if we have a legitimate interest in the disclosure pursuant to Art. 6
            (1)(f) GDPR, or if another legal basis permits the disclosure of this data. When using processors, we only disclose personal data of our customers
            on the basis of a valid contract on data processing. In the case of joint processing, a joint processing agreement is concluded.
        </p>

        <h3>Revocation of your consent to the processing of data</h3>
        <p>
            A wide range of data processing transactions are possible only subject to your express consent. You can also revoke at any time any consent you have
            already given us. This shall be without prejudice to the lawfulness of any data collection that occurred prior to your revocation.
        </p>

        <h3>Right to object to the collection of data in special cases; right to object to direct advertising (Art. 21 GDPR)</h3>
        <p>
            IN THE EVENT THAT DATA ARE PROCESSED ON THE BASIS OF ART. 6(1)(E) OR (F) GDPR, YOU HAVE THE RIGHT TO AT ANY TIME OBJECT TO THE PROCESSING OF YOUR
            PERSONAL DATA BASED ON GROUNDS ARISING FROM YOUR UNIQUE SITUATION. THIS ALSO APPLIES TO ANY PROFILING BASED ON THESE PROVISIONS. TO DETERMINE THE
            LEGAL BASIS, ON WHICH ANY PROCESSING OF DATA IS BASED, PLEASE CONSULT THIS DATA PROTECTION DECLARATION. IF YOU LOG AN OBJECTION, WE WILL NO LONGER
            PROCESS YOUR AFFECTED PERSONAL DATA, UNLESS WE ARE IN A POSITION TO PRESENT COMPELLING PROTECTION WORTHY GROUNDS FOR THE PROCESSING OF YOUR DATA,
            THAT OUTWEIGH YOUR INTERESTS, RIGHTS AND FREEDOMS OR IF THE PURPOSE OF THE PROCESSING IS THE CLAIMING, EXERCISING OR DEFENCE OF LEGAL ENTITLEMENTS
            (OBJECTION PURSUANT TO ART. 21(1) GDPR).
        </p>
        <p>
            IF YOUR PERSONAL DATA IS BEING PROCESSED IN ORDER TO ENGAGE IN DIRECT ADVERTISING, YOU HAVE THE RIGHT TO OBJECT TO THE PROCESSING OF YOUR AFFECTED
            PERSONAL DATA FOR THE PURPOSES OF SUCH ADVERTISING AT ANY TIME. THIS ALSO APPLIES TO PROFILING TO THE EXTENT THAT IT IS AFFILIATED WITH SUCH DIRECT
            ADVERTISING. IF YOU OBJECT, YOUR PERSONAL DATA WILL SUBSEQUENTLY NO LONGER BE USED FOR DIRECT ADVERTISING PURPOSES (OBJECTION PURSUANT TO ART. 21(2)
            GDPR).
        </p>

        <h3>Right to log a complaint with the competent supervisory agency</h3>
        <p>
            In the event of violations of the GDPR, data subjects are entitled to log a complaint with a supervisory agency, in particular in the member state
            where they usually maintain their domicile, place of work or at the place where the alleged violation occurred. The right to log a complaint is in
            effect regardless of any other administrative or court proceedings available as legal recourses.
        </p>

        <h3>Right to data portability</h3>
        <p>
            You have the right to have data that we process automatically on the basis of your consent or in fulfillment of a contract handed over to you or to
            a third party in a common, machine-readable format. If you should demand the direct transfer of the data to another controller, this will be done
            only if it is technically feasible.
        </p>

        <h3>Information about, rectification and eradication of data</h3>
        <p>
            Within the scope of the applicable statutory provisions, you have the right to demand information about your archived personal data, their source
            and recipients as well as the purpose of the processing of your data at any time. You may also have a right to have your data rectified or
            eradicated. If you have questions about this subject matter or any other questions about personal data, please do not hesitate to contact us at any
            time.
        </p>

        <h3>Right to demand processing restrictions</h3>
        <p>
            You have the right to demand the imposition of restrictions as far as the processing of your personal data is concerned. To do so, you may contact
            us at any time. The right to demand restriction of processing applies in the following cases:
        </p>
        <ul>
            <li>
                In the event that you should dispute the correctness of your data archived by us, we will usually need some time to verify this claim. During
                the time that this investigation is ongoing, you have the right to demand that we restrict the processing of your personal data.
            </li>
            <li>
                If the processing of your personal data was/is conducted in an unlawful manner, you have the option to demand the restriction of the processing
                of your data instead of demanding the eradication of this data.
            </li>
            <li>
                If we do not need your personal data any longer and you need it to exercise, defend or claim legal entitlements, you have the right to demand
                the restriction of the processing of your personal data instead of its eradication.
            </li>
            <li>
                If you have raised an objection pursuant to Art. 21(1) GDPR, your rights and our rights will have to be weighed against each other. As long as
                it has not been determined whose interests prevail, you have the right to demand a restriction of the processing of your personal data.
            </li>
        </ul>
        <p>
            If you have restricted the processing of your personal data, these data &ndash; with the exception of their archiving &ndash; may be processed only
            subject to your consent or to claim, exercise or defend legal entitlements or to protect the rights of other natural persons or legal entities or
            for important public interest reasons cited by the European Union or a member state of the EU.
        </p>

        <h3>SSL and/or TLS encryption</h3>
        <p>
            For security reasons and to protect the transmission of confidential content, such as purchase orders or inquiries you submit to us as the website
            operator, this website uses either an SSL or a TLS encryption program. You can recognize an encrypted connection by checking whether the address
            line of the browser switches from &ldquo;http://&rdquo; to &ldquo;https://&rdquo; and also by the appearance of the lock icon in the browser line.
        </p>
        <p>If the SSL or TLS encryption is activated, data you transmit to us cannot be read by third parties.</p>

        <h2>4. Recording of data on this website</h2>

        <h3>Cookies</h3>
        <p>
            Our websites and pages use what the industry refers to as &ldquo;cookies.&rdquo; Cookies are small data packages that do not cause any damage to
            your device. They are either stored temporarily for the duration of a session (session cookies) or they are permanently archived on your device
            (permanent cookies). Session cookies are automatically deleted once you terminate your visit. Permanent cookies remain archived on your device until
            you actively delete them, or they are automatically eradicated by your web browser.
        </p>
        <p>
            Cookies can be issued by us (first-party cookies) or by third-party companies (so-called third-party cookies). Third-party cookies enable the
            integration of certain services of third-party companies into websites (e.g., cookies for handling payment services).
        </p>
        <p>
            Cookies have a variety of functions. Many cookies are technically essential since certain website functions would not work in the absence of these
            cookies (e.g., the shopping cart function or the display of videos). Other cookies may be used to analyze user behavior or for promotional purposes.
        </p>
        <p>
            Cookies, which are required for the performance of electronic communication transactions, for the provision of certain functions you want to use
            (e.g., for the shopping cart function) or those that are necessary for the optimization (required cookies) of the website (e.g., cookies that
            provide measurable insights into the web audience), shall be stored on the basis of Art. 6(1)(f) GDPR, unless a different legal basis is cited. The
            operator of the website has a legitimate interest in the storage of required cookies to ensure the technically error-free and optimized provision of
            the operator&rsquo;s services. If your consent to the storage of the cookies and similar recognition technologies has been requested, the processing
            occurs exclusively on the basis of the consent obtained (Art. 6(1)(a) GDPR and &sect; 25 (1) TDDDG); this consent may be revoked at any time.
        </p>
        <p>
            You have the option to set up your browser in such a manner that you will be notified any time cookies are placed and to permit the acceptance of
            cookies only in specific cases. You may also exclude the acceptance of cookies in certain cases or in general or activate the delete-function for
            the automatic eradication of cookies when the browser closes. If cookies are deactivated, the functions of this website may be limited.
        </p>
        <p>If other cookies and services are used on this website, you can find this information in this privacy policy.</p>

        <h3>Server log files</h3>
        <p>
            The provider of this website and its pages automatically collects and stores information in so-called server log files, which your browser
            communicates to us automatically. The information comprises:
        </p>
        <ul>
            <li>The type and version of browser used</li>
            <li>The used operating system</li>
            <li>Referrer URL</li>
            <li>The hostname of the accessing computer</li>
            <li>The time of the server inquiry</li>
            <li>The IP address</li>
        </ul>
        <p>
            This data is not merged with other data sources. This data is recorded on the basis of Art. 6(1)(f) GDPR. The operator of the website has a
            legitimate interest in the technically error free depiction and the optimization of the operator&rsquo;s website. In order to achieve this, server
            log files must be recorded.
        </p>
        <p>
            We also operate a programmatic interface at <code>/mcp</code>, which serves this documentation to AI development tools. To keep that interface
            available, the server counts the requests received per IP address over a short period in its working memory. This information is not written to
            permanent storage and is not merged with other data. The legal basis is Art. 6(1)(f) GDPR; our legitimate interest lies in protecting the interface
            against overload and abuse.
        </p>

        <h3>Consent record</h3>
        <p>
            When you make a selection in the consent banner on this website, we store that selection on your device, in the local storage of your browser, so
            that you are not asked again on every page. The record contains your selection and the time it was made. It is not transmitted to a server and is
            not merged with other data.
        </p>
        <p>
            Storing this record is technically necessary in order to honor the decision you made, which is why it is set on the basis of Art. 6(1)(f) GDPR and
            &sect; 25 (2) no. 2 TDDDG and does not itself require consent. You can delete it at any time by clearing the site data in your browser; the banner
            will then be displayed again on your next visit.
        </p>

        <h3>Waitlist and forms</h3>
        <p>
            On certain pages (for example, the Lunora Cloud early-access page) we offer a form that allows you to join a waitlist. If you use this form, we
            collect the email address you provide, the consent you give, and the technical metadata of the submission (such as the time of submission). This
            information is used solely to contact you about the matter you signed up for &mdash; for example, to notify you when Lunora Cloud becomes available
            or when a stable release of Lunora ships.
        </p>
        <p>
            The processing of this data is based on your consent (Art. 6(1)(a) GDPR). You may revoke your consent at any time with effect for the future, for
            example by using the unsubscribe link in our emails or by contacting us using the information provided in this privacy policy. The legality of any
            data processing transactions that have already taken place remains unaffected by the revocation.
        </p>
        <p>
            Form submissions are processed on our behalf by our hosting and forms provider, Netlify, Inc. (44 Montgomery Street, Suite 300, San Francisco,
            California 94104, USA), acting as a processor under a data processing agreement (Art. 28 GDPR). Where data is transferred to the USA, the transfer
            is safeguarded by the EU Standard Contractual Clauses and/or the EU&ndash;U.S. Data Privacy Framework.
        </p>
        <p>
            We retain the data you provide via the waitlist until you withdraw your consent or the purpose for storing it ceases to apply (for example, after we
            have processed your request). Mandatory statutory retention periods remain unaffected.
        </p>

        <h3>Request by e-mail</h3>
        <p>
            If you contact us by e-mail, your inquiry including all resulting personal data (name, inquiry) will be stored and processed by us for the purpose
            of processing your request. We do not pass these data on without your consent.
        </p>
        <p>
            The processing of these data is based on Art. 6(1)(b) GDPR if your inquiry is related to the fulfillment of a contract or if it is necessary to
            carry out pre-contractual measures. In all other cases, the data are processed on the basis of our legitimate interest in the effective handling of
            inquiries submitted to us (Art. 6(1)(f) GDPR) or on the basis of your consent (Art. 6(1)(a) GDPR) if it has been obtained; the consent can be
            revoked at any time.
        </p>
        <p>
            The data sent by you to us via contact requests remain with us until you request us to delete, revoke your consent to the storage, or the purpose
            for the data storage lapses (e.g., after completion of your request). Mandatory statutory provisions &ndash; in particular statutory retention
            periods &ndash; remain unaffected.
        </p>

        <h2>5. Analysis tools</h2>

        <h3>PostHog</h3>
        <p>
            This website uses PostHog, a web analysis service. The provider is PostHog, Inc., 965 Mission Street, Suite 425, San Francisco, CA 94103, USA
            (hereinafter &ldquo;PostHog&rdquo;).
        </p>
        <p>
            PostHog enables us to analyze the use of our website. It records, among other things, the pages you visit, the interactions you perform on them
            (e.g., clicks on links and buttons), the referring page, your approximate location derived from your IP address (country and region level), and
            technical information about your browser, operating system and device. If an error occurs while you are using the website, PostHog also records a
            report about that error so that we can fix it. We use this information to understand which content is useful and to improve this website.
        </p>
        <p>
            The use of PostHog is based exclusively on your consent (Art. 6(1)(a) GDPR and &sect; 25 (1) TDDDG). You give this consent via the consent banner
            displayed on this website and can revoke it at any time with effect for the future by changing your selection via the consent settings link in the
            footer of this website. Until you consent, and if you decline or later revoke your consent, PostHog neither stores information on your device nor
            reads information from it; in that case no analysis data is transmitted at all.
        </p>
        <p>
            The data is collected via our own domain (a so-called reverse proxy) and processed in PostHog&rsquo;s European infrastructure. PostHog acts as a
            processor for us on the basis of a data processing agreement (Art. 28 GDPR). Insofar as data is nevertheless accessed from the USA, the transfer is
            safeguarded by the EU Standard Contractual Clauses.
        </p>
        <p>
            The data collected is deleted once it is no longer required for our analysis purposes, at the latest in accordance with the retention periods
            configured with the provider. For more information about how PostHog handles data, please see the provider&rsquo;s privacy policy at:{" "}
            <a href="https://posthog.com/privacy" rel="noopener noreferrer" target="_blank">
                https://posthog.com/privacy
            </a>{" "}
            and the data processing agreement at:{" "}
            <a href="https://posthog.com/dpa" rel="noopener noreferrer" target="_blank">
                https://posthog.com/dpa
            </a>
            .
        </p>
    </ContentPage>
);

export const Route = createFileRoute("/privacy")({
    component: RouteComponent,
    head: () => {
        return {
            ...createSeoHead({
                description: "Lunora privacy policy detailing how we collect, use, and protect your personal data.",
                path: "/privacy",
                title: "Privacy Policy",
            }),
        };
    },
});
